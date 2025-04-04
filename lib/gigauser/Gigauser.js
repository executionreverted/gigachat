// Gigauser.js - Comprehensive User Module for Gigachat
const Autobase = require('autobase')
const BlindPairing = require('blind-pairing')
const HyperDB = require('hyperdb')
const Hyperswarm = require('hyperswarm')
const ReadyResource = require('ready-resource')
const z32 = require('z32')
const b4a = require('b4a')
const crypto = require('crypto')
const { Router, dispatch } = require('./spec/hyperdispatch')
const db = require('./spec/db/index.js')
const GigaRoom = require('../gigaroom/Gigaroom.js')

class GigauserPairer extends ReadyResource {
  constructor(store, invite, opts = {}) {
    super()
    this.store = store
    this.invite = invite
    this.swarm = null
    this.pairing = null
    this.candidate = null
    this.bootstrap = opts.bootstrap || null
    this.onresolve = null
    this.onreject = null
    this.user = null

    this.ready().catch(noop)
  }

  async _open() {
    await this.store.ready();
    this.swarm = new Hyperswarm({
      keyPair: await this.store.createKeyPair('hyperswarm'),
      bootstrap: this.bootstrap
    });

    const store = this.store;
    this.swarm.on('connection', (connection, peerInfo) => {
      store.replicate(connection);
    });

    this.pairing = new BlindPairing(this.swarm);
    const core = Autobase.getLocalCore(this.store);
    await core.ready();
    const key = core.key;
    await core.close();

    this.candidate = this.pairing.addCandidate({
      invite: z32.decode(this.invite),
      userData: key,
      onadd: async (result) => {
        if (this.user === null) {
          this.user = new Gigauser(this.store, {
            swarm: this.swarm,
            key: result.key,
            encryptionKey: result.encryptionKey,
            bootstrap: this.bootstrap,

          });
        }
        this.swarm = null;
        this.store = null;
        if (this.onresolve) this._whenWritable();
        this.candidate.close().catch(noop);
      }
    });
  }

  _whenWritable() {
    if (this.user.base.writable) return
    const check = () => {
      if (this.user.base.writable) {
        this.user.base.off('update', check)

        this.user._loadUserData()
        this.user.once('identity-updated', () => {
          console.log('Identity synchronized to paired device');
        });
        this.onresolve(this.user)
      }

    }
    this.user.base.on('update', check)
  }

  async _close() {
    if (this.candidate !== null) {
      await this.candidate.close()
    }

    if (this.swarm !== null) {
      await this.swarm.destroy()
    }

    if (this.store !== null) {
      await this.store.close()
    }

    if (this.onreject) {
      this.onreject(new Error('Pairing closed'))
    } else if (this.user) {
      await this.user.close()
    }
  }

  finished() {
    return new Promise((resolve, reject) => {
      this.onresolve = resolve
      this.onreject = reject
    })
  }
}

class Gigauser extends ReadyResource {
  constructor(corestore, opts = {}) {

    super()

    this.router = new Router();
    this.store = corestore;
    this.swarm = opts.swarm || null;
    this.base = null;
    this.bootstrap = opts.bootstrap || null;
    this.member = null;
    this.pairing = null;
    this.replicate = opts.replicate !== false;

    this._roomInstances = new Map() // Stores active GigaRoom instances by ID
    this._initializedRooms = {}
    // Identify the bootstrap key
    const key = opts.key ? opts.key : null

    // Core properties
    this.id = null
    this.key = key
    this.discoveryKey = null
    this.keyPair = null
    // User seed and identity
    this.seed = opts.seed || null
    this.publicKey = null

    // User data collections
    this._profile = {
      name: null,
      avatar: null,
      status: null,
      metadata: {}
    }
    this._rooms = []
    this._devices = []
    this._settings = {}
    this.stateUpdateInterval = opts.stateUpdateInterval || 4000 // 4 seconds default
    this._intervalTimer = null
    this._lastUpdateTime = {
      profile: 0,
      rooms: 0,
      devices: 0,
      settings: 0,
      identity: 0
    }

    // Router for handling different types of updates
    this.router = new Router()
    this._registerHandlers()

    this._boot(opts);
    // Prepare for opening
    this.ready().catch(noop)
  }

  _boot(opts = {}) {
    const { encryptionKey, key } = opts

    // Initialize Autobase
    this.base = new Autobase(this.store, key, {
      encrypt: true,
      encryptionKey,
      open: (store) => {
        return HyperDB.bee(store.get('view'), db, {
          extension: false,
          autoUpdate: true
        })
      },
      apply: this._apply.bind(this)
    })

    // Handle base updates
    this.base.on('update', () => {
      if (!this.base._interrupting) {
        this.emit('update')
      }
    })
  }

  _registerHandlers() {
    // Writer management handlers
    this.router.add('@gigauser/remove-writer', async (data, context) => {
      await context.base.removeWriter(data.key)
    })

    this.router.add('@gigauser/add-writer', async (data, context) => {
      await context.base.addWriter(data.key)
    })

    // Invite handler
    this.router.add('@gigauser/add-invite', async (data, context) => {
      await context.view.insert('@gigauser/invite', data);
    });

    // Profile handler
    this.router.add('@gigauser/set-profile', async (data, context) => {
      try {
        await context.view.delete('@gigauser/profile', { key: data.key })
      } catch (e) {
        // Ignore deletion errors
      }
      await context.view.insert('@gigauser/profile', data)
    })

    // Rooms handler
    this.router.add('@gigauser/update-rooms', async (data, context) => {
      try {
        await context.view.delete('@gigauser/rooms', { key: data.key })
      } catch (e) {
        // Ignore deletion errors
      }
      await context.view.insert('@gigauser/rooms', data)
    })

    // Devices handler
    this.router.add('@gigauser/update-devices', async (data, context) => {
      try {
        await context.view.delete('@gigauser/devices', { key: data.key })
      } catch (e) {
        // Ignore deletion errors
      }
      await context.view.insert('@gigauser/devices', data)
    })

    // Settings handler
    this.router.add('@gigauser/update-settings', async (data, context) => {
      try {
        await context.view.delete('@gigauser/settings', { key: data.key })
      } catch (e) {
        // Ignore deletion errors
      }
      await context.view.insert('@gigauser/settings', data)
    })

    this.router.add('@gigauser/set-identity', async (data, context) => {
      try {
        await context.view.delete('@gigauser/identity', { key: 'default' })
      } catch (e) {
        console.log(e)
        // Ignore deletion errors
      }
      await context.view.insert('@gigauser/identity', data)
    })
  }

  // Utility methods
  _safeParseJSON(jsonStr, defaultValue = null) {
    if (!jsonStr) return defaultValue
    try {
      return JSON.parse(jsonStr)
    } catch (err) {
      console.error('JSON parsing error:', err)
      return defaultValue
    }
  }

  _safeKeyString(key) {
    if (typeof key === 'string') return key
    if (Buffer.isBuffer(key)) return b4a.toString(key, 'hex')
    return null
  }

  async createIdentity(seed) {
    if (Array.isArray(seed)) {
      seed = seed.join(' ');
    }

    // Use consistent key derivation
    const keys = Gigauser.deriveKeysFromSeed(seed);
    this.publicKey = keys.publicKey;
    this.keyPair = {
      publicKey: keys.publicKey,
      secretKey: keys.secretKey
    };

    // Also store the encryption key for consistent encryption
    if (!this.base.encryptionKey) {
      this.base.encryptionKey = keys.encryptionKey;
    }
    //
    // Store discovery key for future recovery
    await this.base.append(dispatch('@gigauser/set-identity', {
      key: 'default',
      value: JSON.stringify({
        seed,
        publicKey: b4a.toString(this.publicKey, 'hex'),
        discoveryKey: b4a.toString(keys.discoveryKey, 'hex')
      })
    }));

    await this._createInitialProfile();

    return {
      publicKey: this.publicKey,
      profile: this._profile
    };
  }

  async _createInitialProfile() {
    if (!this.publicKey) return
    const key = this._safeKeyString(this.publicKey)

    this._profile = {
      name: `User-${key.substring(0, 8)}`,
      avatar: null,
      status: 'Available',
      metadata: {}
    }

    await this.base.append(dispatch('@gigauser/set-profile', {
      key,
      value: JSON.stringify(this._profile)
    }))
    this.forceUpdate()
  }

  // Open method
  async _open() {

    await this.base.ready();
    await this._loadUserData()

    if (this.replicate) await this._replicate();

    // Initialize user data
    await this.setupRecoveryResponder()
    // Start the state update interval
    this._startStateUpdateInterval()
  }

  // Apply method for updates
  async _apply(nodes, view, base) {
    // Track which types of data are being updated
    const updates = {
      identity: false,
      profile: false,
      rooms: false,
      devices: false,
      settings: false,
      invites: false,
      writers: false
    };

    // Process each node
    for (const node of nodes) {
      try {
        // Dispatch the command to the router
        await this.router.dispatch(node.value, { view, base });

        // Determine which type of data was updated based on command ID
        const commandId = node.value[0]; // First byte is command ID
        const command = this._getCommandNameById(commandId);

        // Set the appropriate update flag
        if (command.includes('identity')) updates.identity = true;
        if (command.includes('profile')) updates.profile = true;
        if (command.includes('rooms')) updates.rooms = true;
        if (command.includes('devices')) updates.devices = true;
        if (command.includes('settings')) updates.settings = true;
        if (command.includes('invite')) updates.invites = true;
        if (command.includes('writer')) updates.writers = true;

        // Emit a command-specific event with node data
        this.emit(`command:${command}`, node.value);
      } catch (error) {
        console.error(`Error processing command in GigaUser:`, error);
        this.emit('error', error);
      }
    }

    // Ensure the view is flushed
    await view.flush();

    // Refreshing data before emitting events to ensure consistency
    const refreshPromises = [];

    // Identity
    if (updates.identity) {
      refreshPromises.push(this._refreshIdentity());
    }

    // Profile
    if (updates.profile) {
      refreshPromises.push(this._refreshProfile());
    }

    // Rooms
    if (updates.rooms) {
      refreshPromises.push(this._refreshRooms());
    }

    // Devices
    if (updates.devices) {
      refreshPromises.push(this._refreshDevices());
    }

    // Settings
    if (updates.settings) {
      refreshPromises.push(this._refreshSettings());
    }

    // Wait for all refresh operations to complete
    await Promise.all(refreshPromises);

    // Now emit events with refreshed data
    if (updates.identity) this.emit('identity:updated', { publicKey: this.publicKey });
    if (updates.profile) this.emit('profile:updated', this._profile);
    if (updates.rooms) this.emit('rooms:updated', this._rooms);
    if (updates.devices) this.emit('devices:updated', this._devices);
    if (updates.settings) this.emit('settings:updated', this._settings);
    if (updates.invites) this.emit('invites:updated');
    if (updates.writers) this.emit('writers:updated');

    // Emit a general update event
    this.emit('update');

    // Emit a final event indicating all updates are complete
    this.emit('update:complete', Object.keys(updates).filter(key => updates[key]));
  }
  _getCommandNameById(id) {
    // This is a mapping of command IDs to command names
    // You should build this from your command registry
    const commandMap = {
      // Writer commands
      1: 'remove-writer',
      2: 'add-writer',

      // Invite commands
      3: 'add-invite',

      // Profile command
      4: 'set-profile',

      // Room command
      5: 'update-rooms',

      // Device command
      6: 'update-devices',

      // Settings command
      7: 'update-settings',

      // Identity command 
      8: 'set-identity',

      // Add more command mappings as needed
    };

    return commandMap[id] || `unknown-command-${id}`;
  }

  async forceUpdate() {
    await this._loadUserData()
  }

  async _loadUserData() {
    await this._refreshIdentity()
    await this._refreshProfile()
    await this._refreshRooms()
    await this._refreshDevices()
    await this._refreshSettings()
  }


  // Load user data from database
  async _refreshIdentity() {
    try {
      const identityData = await this.base.view.findOne('@gigauser/identity', {});
      if (identityData && identityData.value) {
        const identity = this._safeParseJSON(identityData.value, {});

        if (identity.seed) {
          this.seed = identity.seed;
        }

        if (identity.publicKey) {
          this.publicKey = b4a.from(identity.publicKey, 'hex');
        }
      }

      this._lastUpdateTime.identity = Date.now();
      return true;
    } catch (error) {
      console.error('Error refreshing identity:', error);
      this.emit('error', error);
      return false;
    }
  }

  async _refreshProfile() {
    try {
      if (!this.publicKey) {
        await this._refreshIdentity();
      }

      const key = this._safeKeyString(this.publicKey);
      const profileData = await this.base.view.findOne('@gigauser/profile', { key });

      if (profileData && profileData.value) {
        this._profile = this._safeParseJSON(profileData.value, this._profile);
      }

      this._lastUpdateTime.profile = Date.now();
      return this._profile;
    } catch (error) {
      console.error('Error refreshing profile:', error);
      this.emit('error', error);
      return this._profile;
    }
  }

  async _refreshRooms() {
    try {
      if (!this.publicKey) {
        await this._refreshIdentity();
      }

      const key = this._safeKeyString(this.publicKey);
      const roomsData = await this.base.view.findOne('@gigauser/rooms', { key });

      if (roomsData && roomsData.value) {
        const parsedRooms = this._safeParseJSON(roomsData.value, []);
        this._rooms = [...parsedRooms]
        for (const roomInfo of this._rooms) {
          if (!this._initializedRooms[roomInfo.id] && !this._roomInstances.has(roomInfo.id)) {
            // This is a new room, initialize it
            this._initializeRoomInstance(roomInfo).catch(err => {
              console.error(`Error initializing room ${roomInfo.id}:`, err);
            });
          }
        }
      }


      this._lastUpdateTime.rooms = Date.now();

      return this._rooms;
    } catch (error) {
      console.error('Error refreshing rooms:', error);
      this.emit('error', error);
      return this._rooms;
    }
  }

  async _refreshDevices() {
    try {
      if (!this.publicKey) {
        await this._refreshIdentity();
      }

      const key = this._safeKeyString(this.publicKey);
      const devicesData = await this.base.view.findOne('@gigauser/devices', { key });

      if (devicesData && devicesData.value) {
        this._devices = this._safeParseJSON(devicesData.value, []);
      }

      this._lastUpdateTime.devices = Date.now();
      return this._devices;
    } catch (error) {
      console.error('Error refreshing devices:', error);
      this.emit('error', error);
      return this._devices;
    }
  }

  async _refreshSettings() {
    try {
      if (!this.publicKey) {
        await this._refreshIdentity();
      }

      const key = this._safeKeyString(this.publicKey);
      const settingsData = await this.base.view.findOne('@gigauser/settings', { key });

      if (settingsData && settingsData.value) {
        this._settings = this._safeParseJSON(settingsData.value, {});
      }

      this._lastUpdateTime.settings = Date.now();
      return this._settings;
    } catch (error) {
      console.error('Error refreshing settings:', error);
      this.emit('error', error);
      return this._settings;
    }
  }

  // Helper method to initialize a single room instance
  async _initializeRoomInstance(roomInfo) {
    if (!roomInfo || !roomInfo.id) return null;

    try {
      console.log(`Initializing room instance: ${roomInfo.id}`);

      // Log if this is a creator or joiner room
      if (roomInfo.roomNamespace === roomInfo.id) {
        console.log("Created room, using id as namespace");
      } else if (roomInfo.inviteHash) {
        console.log("Found is invite key, a joined room");
      }

      // Get the room store with the determined namespace
      const roomStore = this.store.namespace(roomInfo.roomNamespace.trim());

      // Create room instance
      const room = new GigaRoom(roomStore, {
        owner: this,
        id: roomInfo.id,
        encryptionKey: roomInfo.encryptionKey
          ? (typeof roomInfo.encryptionKey === 'string'
            ? Buffer.from(roomInfo.encryptionKey, 'hex')
            : roomInfo.encryptionKey)
          : null,
        key: roomInfo.key
          ? Buffer.from(roomInfo.key, 'hex')
          : null,
        discoveryKey: roomInfo.discoveryKey
          ? Buffer.from(roomInfo.discoveryKey, 'hex')
          : null,
        name: roomInfo.name,
        namespace: roomInfo.roomNamespace.trim()
      });

      // Set up event forwarding
      this._setupRoomEvents(room);

      this._roomInstances.set(roomInfo.id, room);
      // Wait for room to be ready
      await room.ready();
      // Store the room instance

      // Emit a room initialized event
      this.emit('room:initialized', roomInfo.id);

      return room;
    } catch (error) {
      console.error(`Error initializing room ${roomInfo.id}:`, error);
      this.emit('error', error);
      return null;
    }
  }
  _setupRoomEvents(room) {
    if (!room) return;

    // Forward specific events with room context
    const eventsToForward = [
      'update', 'error',
      'room:updated', 'members:updated', 'channels:updated',
      'categories:updated', 'roles:updated', 'messages:updated',
      'files:updated', 'reactions:updated', 'invites:updated',
      'permissions:updated', 'threads:updated', 'update:complete'
    ];

    eventsToForward.forEach(eventName => {
      room.on(eventName, (data) => {
        // Forward the event with room context
        this.emit(`room:${eventName}`, {
          roomId: room.id,
          data: data
        });
      });
    });
  }

  // Replication method
  async _replicate() {
    await this.base.ready()
    if (this.swarm === null) {
      this.swarm = new Hyperswarm({
        keyPair: await this.store.createKeyPair('hyperswarm'),
        bootstrap: this.bootstrap
      })
      this.swarm.on('connection', (connection, peerInfo) => {
        this.store.replicate(connection)
      })
    }

    this.pairing = new BlindPairing(this.swarm)
    this.member = this.pairing.addMember({
      discoveryKey: this.base.discoveryKey,
      onadd: async (candidate) => {
        try {
          const inviteBuffer = candidate.inviteId
          let inv = null
          try {
            const stream = this.base.view.find('@gigauser/invite', {})
            for await (const invite of stream) {
              if (b4a.equals(invite.id, inviteBuffer)) {
                inv = invite
                console.log('Found invite by direct invite buffer match')
                break
              }
            }
          } catch (err) {
            console.log('Error finding invite by buffer:', err)
          }

          if (!inv) {
            console.log('No matching invite found in the database, cannot complete pairing')
            return
          }

          const now = Date.now()
          if (inv.expires && inv.expires < now) {
            console.log(`Invite expired: expired at ${new Date(inv.expires).toISOString()}, current time ${new Date(now).toISOString()}`)
            return
          }

          console.log('Found valid invite, proceeding with pairing')

          const id = candidate.inviteId
          if (!b4a.equals(inv.id, id)) {
            console.log('Invite ID mismatch', b4a.toString(inv.id, 'hex'), b4a.toString(id, 'hex'))
            return
          }

          candidate.open(inv.publicKey)
          await this.addWriter(candidate.userData)
          candidate.confirm({
            key: this.base.key,
            encryptionKey: this.base.encryptionKey
          })
          console.log('Confirming, ', this.base.key, ' ', this.base.encryptionKey)
        } catch (err) {
          console.error('Replication error:', err)
        }
      }
    })

    // TODO move this into a different swarm instance for safety
    this.swarm.join(this.base.discoveryKey)

    // seed based pairing
    if (this.seed) {
      const keys = Gigauser.deriveKeysFromSeed(this.seed);
      this.swarm.join(keys.discoveryKey);
    }
  }

  // Close method
  async close() {
    if (this.swarm) {
      if (this.member) await this.member.close()
      if (this.pairing) await this.pairing.close()
      await this.swarm.destroy()
    }

    if (this.base) await this.base.close()
    if (this.local) await this.local.close()
    if (this.store) await this.store.close()
  }

  // Profile management
  async updateProfile(profileData) {
    await this.base.ready()
    if (!profileData) return
    if (!this.publicKey) {
      await this._loadIdentity()
    }

    const key = this._safeKeyString(this.publicKey)

    // Merge with existing profile
    this._profile = {
      ...this._profile,
      ...profileData
    }

    await this.base.append(dispatch('@gigauser/set-profile', {
      key,
      value: JSON.stringify(this._profile)
    }))

    await this._refreshProfile()
  }

  async addWriter(key) {
    await this.base.append(dispatch('@gigauser/add-writer', { key: b4a.isBuffer(key) ? key : b4a.from(key) }));
    return true;
  }

  async removeWriter(key) {
    await this.base.append(dispatch('@gigauser/remove-writer', { key: b4a.isBuffer(key) ? key : b4a.from(key) }));
  }

  // Rooms management
  async addRoom(roomData) {
    if (!this.publicKey) throw new Error('Identity not created')

    const key = this._safeKeyString(this.publicKey)

    // Check if room exists
    const existingIndex = this._rooms.findIndex(r => r.id === roomData.id)

    // Merge function to preserve existing data and fill in missing information
    const mergeRoomData = (existingRoom, newRoomData) => {
      // Create a merged room object
      const mergedRoom = {
        ...existingRoom,
        ...newRoomData,
        // Preserve existing key if not provided
        key: newRoomData.key || existingRoom.key || null,
        // Preserve existing discoveryKey if not provided
        discoveryKey: newRoomData.discoveryKey || existingRoom.discoveryKey || null,
        // Preserve invite-related information
        inviteCode: newRoomData.inviteCode || existingRoom.inviteCode || null,
        encryptionKey: newRoomData.encryptionKey || existingRoom.encryptionKey || null,
        // Always update lastAccessed
        lastAccessed: Date.now(),
      }

      // Add roomNamespace if it's not already present
      if (!mergedRoom.roomNamespace) {
        mergedRoom.roomNamespace = this._normalizeNamespace(
          mergedRoom.roomNamespace || mergedRoom.inviteHash || mergedRoom.id
        );
      }

      return mergedRoom;
    }

    let updatedRooms = [...this._rooms]; // Create a copy to avoid direct mutation

    if (existingIndex >= 0) {
      // Update existing room
      updatedRooms[existingIndex] = mergeRoomData(
        updatedRooms[existingIndex],
        roomData
      )
    } else {
      // Add new room with default values
      const newRoom = (mergeRoomData({}, roomData))
      updatedRooms = [newRoom, ...updatedRooms]
    }

    // Update room data in base
    await this.base.append(dispatch('@gigauser/update-rooms', {
      key,
      value: JSON.stringify(updatedRooms)
    }))

    // Update local cache immediately rather than waiting for _apply
    this._rooms = updatedRooms

    // Emit the event with the updated room list
    this.emit('rooms:updated', this._rooms)

    return this._rooms
  }


  async refreshRooms() {
    console.log('_apply room-updated')
    await this.base.ready()
    if (!this.publicKey) return
    this._refreshRooms()
  }

  async removeRoom(roomId) {
    if (!this.publicKey) throw new Error('Identity not created')

    const key = this._safeKeyString(this.publicKey)

    // Filter out the room
    this._rooms = this._rooms.filter(r => r.id !== roomId)

    await this.base.append(dispatch('@gigauser/update-rooms', {
      key,
      value: JSON.stringify(this._rooms)
    }))

    return this._rooms
  }

  async addDevice(deviceData) {
    if (!this.publicKey) throw new Error('Identity not created')

    const key = this._safeKeyString(this.publicKey)
    const deviceKey = this._safeKeyString(deviceData.publicKey)

    if (!deviceKey) {
      throw new Error('Invalid device public key')
    }

    // First get current devices from DB
    let currentDevices = []
    try {
      const result = await this.base.view.findOne('@gigauser/devices', { key })
      currentDevices = result && result.value ?
        this._safeParseJSON(result.value, []) :
        []
    } catch (err) {
      console.error('Error retrieving current devices:', err)
    }

    // Check if device already exists
    const existingIndex = currentDevices.findIndex(d =>
      this._safeKeyString(d.publicKey) === deviceKey
    )

    if (existingIndex >= 0) {
      // Update existing device
      currentDevices[existingIndex] = {
        ...currentDevices[existingIndex],
        ...deviceData,
        publicKey: deviceKey,
        lastSeen: Date.now()
      }
    } else {
      // Add new device
      currentDevices.push({
        ...deviceData,
        publicKey: deviceKey,
        lastSeen: Date.now()
      })
    }

    await this.base.append(dispatch('@gigauser/update-devices', {
      key,
      value: JSON.stringify(currentDevices)
    }))

    // Update local devices
    this._devices = currentDevices

    return this._devices
  }


  async removeDevice(deviceKey) {
    if (!this.publicKey) throw new Error('Identity not created')

    const key = this._safeKeyString(this.publicKey)
    const deviceKeyStr = this._safeKeyString(deviceKey)

    // Filter out the device
    this._devices = this._devices.filter(d =>
      this._safeKeyString(d.publicKey) !== deviceKeyStr
    )

    await this.base.append(dispatch('@gigauser/update-devices', {
      key,
      value: JSON.stringify(this._devices)
    }))

    return this._devices
  }

  // Settings management
  async updateSettings(settingsData) {
    await this.base.ready()

    await this.delay(200)
    if (!this.publicKey) throw new Error('Identity not created')

    const key = this._safeKeyString(this.publicKey)
    // Merge with existing settings
    this._settings = {
      ...this._settings,
      ...settingsData
    }

    await this.base.append(dispatch('@gigauser/update-settings', {
      key,
      value: JSON.stringify(this._settings)
    }))

    return this._settings
  }

  async refreshSettings() {
    if (!this.publicKey) return
    await this.base.ready()
    const key = this._safeKeyString(this.publicKey)
    const settingsData = await this.base.view.findOne('@gigauser/settings', { key })
    console.log(settingsData)
    if (settingsData && settingsData.value) {
      this._settings = this._safeParseJSON(settingsData.value, {})
    }
  }

  static deriveKeysFromSeed(seed) {
    const seedPhrase = Array.isArray(seed) ? seed.join(' ') : seed;
    const seedBuffer = b4a.from(seedPhrase);

    // Master hash
    const masterHash = crypto.createHash('sha256').update(seedBuffer).digest();

    // Derive keys
    return {
      publicKey: masterHash.slice(0, 32),
      secretKey: masterHash,
      discoveryKey: crypto.createHash('sha256')
        .update(Buffer.concat([masterHash, Buffer.from('discovery')]))
        .digest(),
      encryptionKey: crypto.createHash('sha256')
        .update(Buffer.concat([masterHash, Buffer.from('encryption')]))
        .digest()
    };
  }

  // Invite and device pairing methods
  async createPairingInvite() {
    if (this.opened === false) await this.ready()
    // Create a new invite
    const { id, invite, publicKey, expires } = BlindPairing.createInvite(this.base.key)
    const record = { id, invite, publicKey, expires }

    // Log the invite details to help with debugging
    console.log('Creating new invite:', {
      id: b4a.toString(id, 'hex'),
      publicKey: b4a.toString(publicKey, 'hex'),
      expires
    })

    await this.base.append(dispatch('@gigauser/add-invite', record))
    return z32.encode(record.invite)
  }

  // Static method for pairing a new device
  static async pairDevice(store, inviteCode, opts = {}) {
    if (!store) throw new Error('Corestore is required')
    if (!inviteCode) throw new Error('Invite code is required')

    try {
      const pair = Gigauser.pair(store, inviteCode, opts)

      // Add a global timeout
      const pairingPromise = pair.finished()
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Pairing timed out')), 45000)
      )

      const user = await Promise.race([pairingPromise, timeoutPromise])
      await user.ready()
      return user
    } catch (err) {
      console.error('Comprehensive pairing error:', err)
      console.error('Pairing error stack:', err.stack)
      throw err
    }
  }

  // Getters for easy access to user data
  get profile() {
    return this._profile
  }

  set profile(v) {
    this._profile = v
  }

  get rooms() {
    return this._rooms
  }

  get devices() {
    return this._devices
  }

  get settings() {
    return this._settings
  }

  get roomInstances() {
    return this._roomInstances
  }

  // Static method for creating a new user
  static async create(store, seed, opts = {}) {
    const user = new Gigauser(store, { ...opts, seed })
    console.log('Gigauser.create - Instance created')

    try {
      await user.ready()
      console.log('Gigauser.create - Ready called')
      if (!user.publicKey && seed) {
        await user.createIdentity(seed)
      }
      console.log('Gigauser.create - Identity created')

      return user
    } catch (error) {
      console.error('Gigauser.create - Error:', error)
      console.error('Gigauser.create - Error stack:', error.stack)
      throw error
    }
  }

  // Pair method
  static pair(store, invite, opts) {
    return new GigauserPairer(store, invite, opts)
  }

  static async recoverFromSeed(store, seed, opts = {}) {
    const seedPhrase = Array.isArray(seed) ? seed.join(' ') : seed;
    console.log('Starting recovery from seed phrase');

    // Derive keys from seed
    const keys = this.deriveKeysFromSeed(seedPhrase);

    // Create swarm for networking
    const swarm = new Hyperswarm({
      keyPair: await store.createKeyPair('hyperswarm'),
      bootstrap: opts.bootstrap || null
    });

    const recoveryTimeout = opts.timeout || 120000; // 2 minutes

    // Set up invite collection
    let receivedInvite = null;

    // Setup connection handler
    swarm.on('connection', (connection, peerInfo) => {
      console.log('Connected to peer:', peerInfo.publicKey.toString('hex').substring(0, 8));

      // Set up data handler for invite responses
      connection.on('data', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'invite-response' && message.invite) {
            console.log('Received invite code from peer');
            receivedInvite = message.invite;
          }
        } catch (err) {
          // Ignore non-JSON data
        }
      });

      // Send invite request
      const requestMessage = JSON.stringify({
        type: 'invite-request',
        publicKey: keys.publicKey.toString('hex'),
        timestamp: Date.now()
      });

      connection.write(Buffer.from(requestMessage));
    });

    // Join the recovery topic
    console.log('Joining seed-derived topic:', keys.discoveryKey.toString('hex').substring(0, 8));
    swarm.join(keys.discoveryKey);

    try {
      // Promise that resolves when an invite is received
      const invitePromise = new Promise(resolve => {
        const checkInterval = setInterval(() => {
          if (receivedInvite) {
            clearInterval(checkInterval);
            resolve(receivedInvite);
          }
        }, 500);
      });

      // Promise that rejects after timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('Recovery timeout: No invite received'));
        }, recoveryTimeout);
      });

      // Wait for either an invite or timeout
      console.log('Waiting for invite response...');
      const invite = await Promise.race([invitePromise, timeoutPromise]);

      // If we got here, we received an invite
      console.log('Successfully received invite, pairing device...');
      await swarm.destroy();

      // Use the existing pairing mechanism
      return await Gigauser.pairDevice(store, invite, opts);

    } catch (error) {
      console.log(error.message);

      // Clean up
      await swarm.destroy();

      // If timeout or error, create new user
      if (error.message.includes('timeout') || error.message.includes('No invite')) {
        console.log('Creating new user with seed');
        return await Gigauser.create(store, seedPhrase, opts);
      }

      // For other errors, propagate
      throw error;
    }
  }
  // Add this method to Gigauser class
  async setupRecoveryResponder() {
    if (!this.seed || !this.swarm) return;

    const keys = Gigauser.deriveKeysFromSeed(this.seed);

    // Join the recovery topic
    console.log('Setting up recovery responder on topic:', keys.discoveryKey.toString('hex').substring(0, 8));
    this.swarm.join(keys.discoveryKey);

    // Listen for connections and respond to invite requests
    this.swarm.on('connection', async (connection, peerInfo) => {
      console.log('Recovery topic connection from:', peerInfo.publicKey.toString('hex').substring(0, 8));

      connection.on('data', async (data) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'invite-request') {
            console.log('Received invite request, generating invite');

            try {
              // Generate a fresh invite
              const invite = await this.createPairingInvite();

              // Send invite response
              const response = JSON.stringify({
                type: 'invite-response',
                invite,
                timestamp: Date.now()
              });

              connection.write(Buffer.from(response));
              console.log('Sent invite response to peer');
            } catch (err) {
              console.error('Error generating or sending invite:', err);
            }
          }
        } catch (err) {
          // Ignore non-JSON data
        }
      });
    });
  }


  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }




  // Rooms
  async createRoom(newRoomData) {
    await this.base.ready()
    if (!this.publicKey) throw new Error('Identity not created')

    // Generate a unique room ID with NO trailing spaces!
    const roomId = crypto.randomBytes(8).toString('hex')
    newRoomData.id = roomId
    const roomNamespace = `${roomId}`.trim()
    console.log(`Creating room with namespace: ${roomNamespace}`)

    const roomStore = this.store.namespace(roomNamespace)

    // Create the room using GigaRoom.create with explicit namespace
    const room = new GigaRoom(roomStore, {
      id: roomId,
      owner: this,
      namespace: newRoomData?.roomNamespace || roomNamespace,
      name: newRoomData.name
    })

    try {
      await room.ready()
      await room.initRoomParams(newRoomData, this.publicKey)

      // Ensure room is added to user's rooms with consistent namespace
      await this.addRoom({
        id: room.id,
        name: room.name,
        description: room.description,
        key: room.base.key ? room.base.key.toString('hex') : null,
        discoveryKey: room.base.discoveryKey ? room.base.discoveryKey.toString('hex') : null,
        roomNamespace: roomNamespace, // Consistent namespace with NO trailing space
        createdAt: Date.now(),
        encryptionKey: room.base.encryptionKey.toString('hex'),
        inviteHash: null,
      })

      // Store instance with clean namespace
      this._roomInstances.set(room.id, room)

      // Emit room creation event with consistent data
      this.emit('room:created', {
        roomId: room.id,
        name: room.name,
        key: room.base.key ? room.base.key.toString('hex') : null
      })

      return room
    } catch (error) {
      console.error('Error creating room:', error)
      this.emit('error', error)
      throw error
    }
  }

  async joinRoom(inviteCode, opts = {}) {
    console.log('Joining room with invite:', inviteCode.substring(0, 10))

    if (!this.publicKey) throw new Error('Identity not created')

    // Validate invite code
    if (!this._validateInviteCode(inviteCode)) {
      throw new Error('Invalid invite code')
    }

    // Derive a deterministic namespace from invite code - ENSURE NO TRAILING SPACE
    const inviteHash = crypto.createHash('sha256')
      .update(inviteCode)
      .digest('hex')
      .slice(0, 16);
    const roomNamespace = this._normalizeNamespace(inviteHash);

    // Ensure store is ready before creating namespace
    if (typeof this.store.ready !== 'function') {
      throw new Error('Invalid corestore: missing ready method')
    }

    try {
      // Wait for store to be ready
      await this.store.ready()

      // Create room store with namespace
      const roomStore = this.store.namespace(roomNamespace)

      // Ensure room store is also ready
      if (typeof roomStore.ready !== 'function') {
        throw new Error('Invalid room namespace: missing ready method')
      }
      await roomStore.ready()

      // Use GigaRoom's join method, passing namespace for consistency
      const room = await GigaRoom.joinRoom(roomStore, inviteCode, {
        owner: this,
        userKey: this.publicKey,
        displayName: this._profile.name || 'User',
        namespace: roomNamespace, // Pass namespace explicitly
        ...opts
      })

      await room.ready()
      await room.forceUpdate()

      const roomData = await room.getRoomData()

      // Add to rooms list with consistent namespace
      await this.addRoom({
        id: roomData.id,
        name: room.name,
        description: room.description,
        key: room.base.key ? room.base.key.toString('hex') : null,
        discoveryKey: room.base.discoveryKey ? room.base.discoveryKey.toString('hex') : null,
        createdAt: room.createdAt || Date.now(),
        inviteCode: inviteCode,
        inviteHash: inviteHash,
        roomNamespace: roomNamespace, // No trailing spaces!
        encryptionKey: room.base.encryptionKey.toString('hex'),
      })

      // Store instance with clean namespace
      this._roomInstances.set(room.id, room)

      // Emit room joined event
      this.emit('room:joined', {
        roomId: room.id,
        name: room.name
      })

      return room
    } catch (error) {
      console.error('Error joining room:', error)
      this.emit('error', error)
      throw error
    }
  }

  // Invite code validation method
  _validateInviteCode(inviteCode) {
    // Implement invite code validation logic
    // e.g., check length, format, decode successfully
    try {
      z32.decode(inviteCode)
      return true
    } catch (error) {
      return false
    }
  }


  async getRoom(roomId) {
    console.log(`getRoom called with roomId: ${roomId}`)

    // First, normalize the namespace by trimming whitespace
    const normalizedId = typeof roomId === 'string' ? roomId.trim() : roomId

    // Check if room exists in instance cache with normalized ID
    if (this._roomInstances.has(normalizedId)) {
      console.log(`Room found in instance cache with normalized ID: ${normalizedId}`)
      return this._roomInstances.get(normalizedId)
    }

    // Check if room exists in instance cache with original ID
    if (roomId !== normalizedId && this._roomInstances.has(roomId)) {
      console.log(`Room found in instance cache with original ID: ${roomId}`)
      return this._roomInstances.get(roomId)
    }

    // Find room in room list
    console.log('Looking for room in room list:', this._rooms.map(r => r.roomNamespace))
    let roomInfo = this._rooms.find(r => {
      // Try both direct match and normalized match
      const normalizedNamespace = r.roomNamespace ? r.roomNamespace.trim() : roomNamespace
      return normalizedNamespace === normalizedId || r.roomNamespace === roomId
    })

    if (!roomInfo) {
      throw new Error(`Room not found: ${roomId}. Available rooms: ${this._rooms.map(r => r.roomNamespace).join(', ')}`)
    }
    return await this._initializeRoomInstance(roomInfo)
  }


  async updateRooms(rooms) {
    if (!this.publicKey) throw new Error("Public key is missing")
    if (!rooms) {
      throw new Error("updateRooms: Invalid rooms arg passed")
    }
    const key = this._safeKeyString(this.publicKey)
    await this.base.append(dispatch('@gigauser/update-rooms', {
      key,
      value: JSON.stringify(rooms)
    }))
  }

  // Leave a room
  async leaveRoom(roomId) {
    // Get the room instance
    let room
    try {
      room = await this.getRoom(roomId)
    } catch (err) {
      // Room might not be loaded, just remove from list
      const updatedRooms = this._rooms.filter(r => r.id !== roomId)
      await this.updateRooms(updatedRooms)
      return true
    }

    // Remove self from room members
    const memberInfo = room.members.find(m =>
      Buffer.isBuffer(m.userKey)
        ? m.userKey.equals(this.publicKey)
        : m.userKey === this.publicKey.toString('hex')
    )

    if (memberInfo) {
      await room.removeMember(memberInfo.id)
    }

    // Close the room instance
    await room.close()

    // Remove from instances map
    this._roomInstances.delete(roomNamespace)

    // Remove from rooms list
    const updatedRooms = this._rooms.filter(r => r.id !== roomId)
    await this.updateRooms(updatedRooms)

    return true
  }

  // Close all room instances
  async closeAllRooms() {
    const promises = []
    for (const room of this._roomInstances.values()) {
      promises.push(room.close())
    }

    await Promise.all(promises)
    this._roomInstances.clear()
  }

  /**
   * Starts the interval for periodic state updates
   * @private
   */
  _startStateUpdateInterval() {
    // Clear any existing interval first
    this._stopStateUpdateInterval()

    // Set up the new interval
    this._intervalTimer = setInterval(async () => {
      await this._emitLatestStates()
    }, this.stateUpdateInterval)

    // Prevent the interval from keeping the process alive
    if (this._intervalTimer && this._intervalTimer.unref) {
      this._intervalTimer.unref()
    }

    console.log(`State update interval started (${this.stateUpdateInterval}ms)`)
  }

  /**
   * Stops the state update interval
   * @private
   */
  _stopStateUpdateInterval() {
    if (this._intervalTimer) {
      clearInterval(this._intervalTimer)
      this._intervalTimer = null
      console.log('State update interval stopped')
    }
  }

  async _refreshAndEmitProfile() {
    try {
      // Store the original value for comparison
      const originalProfile = JSON.stringify(this._profile)

      // Refresh the data
      await this._refreshProfile()

      // Update the last update time
      this._lastUpdateTime.profile = Date.now()

      // Check if the value changed
      const newProfile = JSON.stringify(this._profile)
      if (originalProfile !== newProfile) {
        // Only emit if there was a change
        this.emit('profile:updated', this._profile)
      }

      return true
    } catch (error) {
      console.error('Error refreshing profile:', error)
      return false
    }
  }

  /**
   * Refreshes identity data and emits an event if changed
   * @private
   */
  async _refreshAndEmitIdentity() {
    try {
      // Store the original value for comparison
      const originalPublicKey = this.publicKey ? this.publicKey.toString('hex') : null

      // Refresh the data
      await this._refreshIdentity()

      // Update the last update time
      this._lastUpdateTime.identity = Date.now()

      // Check if the value changed
      const newPublicKey = this.publicKey ? this.publicKey.toString('hex') : null
      if (originalPublicKey !== newPublicKey) {
        // Only emit if there was a change
        this.emit('identity:updated', { publicKey: this.publicKey })
      }

      return true
    } catch (error) {
      console.error('Error refreshing identity:', error)
      return false
    }
  }

  /**
   * Refreshes rooms data and emits an event if changed
   * @private
   */
  async _refreshAndEmitRooms() {
    try {
      // Store the original value for comparison
      const originalRooms = JSON.stringify(this._rooms)

      // Refresh the data
      await this._refreshRooms()

      // Update the last update time
      this._lastUpdateTime.rooms = Date.now()

      // Check if the value changed
      const newRooms = JSON.stringify(this._rooms)
      if (originalRooms !== newRooms) {
        // Only emit if there was a change
        this.emit('rooms:updated', this._rooms)
      }

      return true
    } catch (error) {
      console.error('Error refreshing rooms:', error)
      return false
    }
  }

  /**
   * Refreshes devices data and emits an event if changed
   * @private
   */
  async _refreshAndEmitDevices() {
    try {
      // Store the original value for comparison
      const originalDevices = JSON.stringify(this._devices)

      // Refresh the data
      await this._refreshDevices()

      // Update the last update time
      this._lastUpdateTime.devices = Date.now()

      // Check if the value changed
      const newDevices = JSON.stringify(this._devices)
      if (originalDevices !== newDevices) {
        // Only emit if there was a change
        this.emit('devices:updated', this._devices)
      }

      return true
    } catch (error) {
      console.error('Error refreshing devices:', error)
      return false
    }
  }

  /**
   * Refreshes settings data and emits an event if changed
   * @private
   */
  async _refreshAndEmitSettings() {
    try {
      // Store the original value for comparison
      const originalSettings = JSON.stringify(this._settings)

      // Refresh the data
      await this._refreshSettings()

      // Update the last update time
      this._lastUpdateTime.settings = Date.now()

      // Check if the value changed
      const newSettings = JSON.stringify(this._settings)
      if (originalSettings !== newSettings) {
        // Only emit if there was a change
        this.emit('settings:updated', this._settings)
      }

      return true
    } catch (error) {
      console.error('Error refreshing settings:', error)
      return false
    }
  }


  async _emitLatestStates() {
    try {
      // Skip if not ready or closed
      if (!this.opened || this.closing) return

      const now = Date.now()
      const refreshPromises = []

      // Only refresh data that hasn't been updated in the last interval
      // This prevents unnecessary refreshes if data was just updated
      if (now - this._lastUpdateTime.identity > this.stateUpdateInterval) {
        refreshPromises.push(this._refreshAndEmitIdentity())
      }

      if (now - this._lastUpdateTime.profile > this.stateUpdateInterval) {
        refreshPromises.push(this._refreshAndEmitProfile())
      }

      if (now - this._lastUpdateTime.rooms > this.stateUpdateInterval) {
        refreshPromises.push(this._refreshAndEmitRooms())
      }

      if (now - this._lastUpdateTime.devices > this.stateUpdateInterval) {
        refreshPromises.push(this._refreshAndEmitDevices())
      }

      if (now - this._lastUpdateTime.settings > this.stateUpdateInterval) {
        refreshPromises.push(this._refreshAndEmitSettings())
      }

      // Wait for all refreshes to complete
      await Promise.all(refreshPromises)

      // Emit a combined state update event with all the latest data
      this.emit('state:periodic-update', {
        timestamp: now,
        identity: this.publicKey ? { publicKey: this.publicKey.toString('hex') } : null,
        profile: this._profile,
        rooms: this._rooms,
        devices: this._devices,
        settings: this._settings
      })

    } catch (error) {
      console.error('Error in periodic state update:', error)
      this.emit('error', error)
    }
  }

  // Override the close method to also close rooms
  async close() {
    await this.closeAllRooms()
    // Call the original close method
    await super.close()
  }

  _normalizeNamespace(namespace) {
    return (typeof namespace === 'string') ? namespace.trim() : null;
  }
}



function noop(e) {
  console.log('op', e)
}

module.exports = Gigauser
