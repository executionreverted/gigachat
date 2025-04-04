// GigaRoom.js - Main room module for Gigachat
// This class is designed to be managed by GigaUser instances, where each user
// can have multiple rooms (similar to Discord servers)
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

class GigaRoomPairer extends ReadyResource {
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
    this.room = null
    this.owner = opts.owner

    this.ready().catch(noop)
  }

  async _open() {
    await this.store.ready()
    this.swarm = new Hyperswarm({
      keyPair: await this.store.createKeyPair('hyperswarm'),
      bootstrap: this.bootstrap
    })

    const store = this.store
    this.swarm.on('connection', (connection, peerInfo) => {
      store.replicate(connection)
    })

    this.pairing = new BlindPairing(this.swarm)
    const core = Autobase.getLocalCore(this.store)
    await core.ready()
    const key = core.key
    await core.close()
    const inviteHash = crypto.createHash('sha256')
      .update(this.invite)
      .digest('hex')
      .slice(0, 16);
    const roomNamespace = inviteHash?.trim();
    console.log(this.invite)

    this.candidate = this.pairing.addCandidate({
      invite: z32.decode(this.invite),
      userData: key,
      onadd: async (result) => {
        if (this.room === null) {
          this.room = new GigaRoom(this.store, {
            swarm: this.swarm,
            key: result.key,
            encryptionKey: result.encryptionKey,
            bootstrap: this.bootstrap,
            owner: this.owner,
            namespace: roomNamespace
          })
        }
        this.swarm = null
        this.store = null
        if (this.onresolve) this._whenWritable()
        this.candidate.close().catch(noop)
      }
    })
  }

  _whenWritable() {
    if (this.room.base.writable) return
    const check = () => {
      if (this.room.base.writable) {
        this.room._loadRoomData()
        this.room.base.off('update', check)
        this.onresolve(this.room)
      }
    }
    this.room.base.on('update', check)
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
    } else if (this.room) {
      await this.room.close()
    }
  }

  finished() {
    return new Promise((resolve, reject) => {
      this.onresolve = resolve
      this.onreject = reject
    })
  }
}

class GigaRoom extends ReadyResource {
  constructor(corestore, opts = {}) {
    super()

    // Core components
    this.router = new Router()
    this.store = corestore
    this.swarm = opts.swarm || null
    this.base = null
    this.bootstrap = opts.bootstrap || null
    this.member = null
    this.pairing = null
    this.replicate = opts.replicate !== false
    this.blobsCoreKey = null



    // Owner reference - the GigaUser that owns/manages this room
    this.owner = opts.owner || null

    // Room properties
    this.id = opts.id || null
    this.key = opts.key || null
    this.discoveryKey = opts.discoveryKey || null
    this.name = opts.name || null
    this.description = opts.description || null
    this.createdBy = opts.createdBy || null
    this.createdAt = opts.createdAt || null
    this.isPrivate = opts.isPrivate || false
    this.isEncrypted = opts.isEncrypted || false

    this.namespace = opts.namespace || null
    // Room data collections
    this._members = []
    this._channels = []
    this._categories = []
    this._roles = []
    this._settings = {}

    // Register handlers for commands
    this._registerHandlers()

    // Initialize autobase
    this._boot(opts)

    // Prepare for opening
    this.ready().catch(noop)
  }

  _boot(opts = {}) {
    const { encryptionKey, key } = opts

    // Initialize Autobase with proper handlers
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

    this.base.on('update', () => {
      if (!this.base._interrupting) {
        this.emit('update')
      }
    })
  }

  async _safeDispatch(command, data) {
    // Create a proper command dispatch with the correct format
    try {
      // Use the imported dispatch function to format the command correctly
      const dispatchedCommand = dispatch(command, data);

      // Now append this properly formatted command to the base
      return await this.base.append(dispatchedCommand);
    } catch (error) {
      console.error(`Error dispatching command ${command}:`, error);
      throw error;
    }
  }

  _registerHandlers() {
    // Writer management
    this.router.add('@gigaroom/remove-writer', async (data, context) => {
      await context.base.removeWriter(data.key)
    })

    this.router.add('@gigaroom/add-writer', async (data, context) => {
      await context.base.addWriter(data.key)
    })

    // Invite management
    this.router.add('@gigaroom/add-invite', async (data, context) => {
      await context.view.insert('@gigaroom/invite', data)
    })

    // Room management
    this.router.add('@gigaroom/create-room', async (data, context) => {
      await context.view.insert('@gigaroom/room', data)
    })

    this.router.add('@gigaroom/update-room', async (data, context) => {
      try {
        await context.view.delete('@gigaroom/room', { id: data.id })
      } catch (e) {
        // Ignore deletion errors
      }
      await context.view.insert('@gigaroom/room', data)
    })

    // Member management
    this.router.add('@gigaroom/add-member', async (data, context) => {
      await context.view.insert('@gigaroom/member', data)
    })

    this.router.add('@gigaroom/update-member', async (data, context) => {
      try {
        await context.view.delete('@gigaroom/member', { id: data.id })
      } catch (e) {
        // Ignore deletion errors
      }
      await context.view.insert('@gigaroom/member', data)
    })

    this.router.add('@gigaroom/remove-member', async (data, context) => {
      await context.view.delete('@gigaroom/member', { id: data.id })
    })

    // Channel management
    this.router.add('@gigaroom/create-channel', async (data, context) => {
      await context.view.insert('@gigaroom/channel', data)
    })

    this.router.add('@gigaroom/update-channel', async (data, context) => {
      try {
        await context.view.delete('@gigaroom/channel', { id: data.id })
      } catch (e) {
        // Ignore deletion errors
      }
      await context.view.insert('@gigaroom/channel', data)
    })

    this.router.add('@gigaroom/delete-channel', async (data, context) => {
      await context.view.delete('@gigaroom/channel', { id: data.id })
    })

    // Category management
    this.router.add('@gigaroom/create-category', async (data, context) => {
      await context.view.insert('@gigaroom/category', data)
    })

    this.router.add('@gigaroom/create-role', async (data, context) => {
      await context.view.insert('@gigaroom/role', data)
    })

    this.router.add('@gigaroom/update-role', async (data, context) => {
      try {
        await context.view.delete('@gigaroom/role', { id: data.id })
      } catch (e) {
        // Ignore deletion errors
      }
      await context.view.insert('@gigaroom/role', data)
    })

    this.router.add('@gigaroom/delete-role', async (data, context) => {
      await context.view.delete('@gigaroom/role', { id: data.id })
    })

    // Add similar placeholder handlers for other commands if needed
    this.router.add('@gigaroom/set-permission-override', async (data, context) => {
      await context.view.insert('@gigaroom/permissionOverride', data)
    })

    // Add more empty handlers for other commands in the schema
    // This prevents the "Missing handler" error while providing a basic implementation
    const placeholderCommands = [
      '@gigaroom/add-message',
      '@gigaroom/edit-message',
      '@gigaroom/delete-message',
      '@gigaroom/add-reaction',
      '@gigaroom/remove-reaction',
      '@gigaroom/add-file',
      '@gigaroom/add-mention',
      '@gigaroom/update-category',
      '@gigaroom/delete-category',
      '@gigaroom/create-thread',
      '@gigaroom/update-thread'
    ]

    placeholderCommands.forEach(command => {
      this.router.add(command, async (data, context) => {
        // Basic insertion or update logic
        try {
          await context.view.insert(command.replace('@gigaroom/', '@gigaroom/'), data)
        } catch (error) {
          console.warn(`Placeholder handler for ${command}:`, error)
        }
      })
    })

    // Add more handlers as needed
  }

  // Apply updates from autobase
  async _apply(nodes, view, base) {
    // Track which types of data are being updated
    const updates = {
      room: false,
      messages: false,
      members: false,
      channels: false,
      categories: false,
      roles: false,
      files: false,
      reactions: false,
      invites: false,
      permissions: false,
      threads: false
    };

    // Process each node
    for (const node of nodes) {
      try {
        // Dispatch the command to the router
        await this.router.dispatch(node.value, { view, base });

        // Determine which type of data was updated based on command ID
        const commandId = node.value[0]; // First byte is command ID


        if (isNaN(commandId)) {
          console.warn('Received invalid command ID (NaN), skipping node:', node.value);
          continue;
        }
        const command = this._getCommandNameById(commandId);


        // Set the appropriate update flag
        if (command.includes('room')) updates.room = true;
        if (command.includes('message')) updates.messages = true;
        if (command.includes('member')) updates.members = true;
        if (command.includes('channel')) updates.channels = true;
        if (command.includes('category')) updates.categories = true;
        if (command.includes('role')) updates.roles = true;
        if (command.includes('file')) updates.files = true;
        if (command.includes('reaction')) updates.reactions = true;
        if (command.includes('invite')) updates.invites = true;
        if (command.includes('permission')) updates.permissions = true;
        if (command.includes('thread')) updates.threads = true;

        // Emit a command-specific event with node data
        this.emit(`command:${command}`, node.value);
      } catch (error) {
        console.error(`Error processing command in GigaRoom:`, error);
        this.emit('error', error);
      }
    }

    // Ensure the view is flushed
    await view.flush();

    // Emit a general update event
    this.emit('update');

    // Conditionally refresh data and emit specific events
    const refreshPromises = [];

    // Room data
    if (updates.room) {
      refreshPromises.push(this._refreshRoom().then(() => {
        this.emit('room:updated', this.id);
      }));
    }

    // Members 
    if (updates.members) {
      refreshPromises.push(this._refreshMembers().then(() => {
        this.emit('members:updated', this._members);
      }));
    }

    // Channels
    if (updates.channels) {
      refreshPromises.push(this._refreshChannels().then(() => {
        this.emit('channels:updated', this._channels);
      }));
    }

    // Categories
    if (updates.categories) {
      refreshPromises.push(this._refreshCategories().then(() => {
        this.emit('categories:updated', this._categories);
      }));
    }

    // Roles
    if (updates.roles) {
      refreshPromises.push(this._refreshRoles().then(() => {
        this.emit('roles:updated', this._roles);
      }));
    }

    // Other data types...
    if (updates.messages) this.emit('messages:updated');
    if (updates.files) this.emit('files:updated');
    if (updates.reactions) this.emit('reactions:updated');
    if (updates.invites) this.emit('invites:updated');
    if (updates.permissions) this.emit('permissions:updated');
    if (updates.threads) this.emit('threads:updated');

    // Wait for all refresh operations to complete
    await Promise.all(refreshPromises);

    // Emit a final event indicating all updates are complete
    this.emit('update:complete', Object.keys(updates).filter(key => updates[key]));
  }


  _getCommandNameById(id) {
    // Complete mapping of command IDs to command names based on hyperdispatch schema
    const commandMap = {
      // Writer management commands
      0: 'remove-writer',
      1: 'add-writer',

      // Invite commands
      2: 'add-invite',

      // Room commands
      3: 'create-room',
      4: 'update-room',

      // Member commands
      5: 'add-member',
      6: 'update-member',
      7: 'remove-member',

      // Role commands
      8: 'create-role',
      9: 'update-role',
      10: 'delete-role',

      // Permission commands
      11: 'set-permission-override',

      // Channel commands
      12: 'create-channel',
      13: 'update-channel',
      14: 'delete-channel',

      // Category commands
      15: 'create-category',
      16: 'update-category',
      17: 'delete-category',

      // Thread commands
      18: 'create-thread',
      19: 'update-thread',

      // Message commands
      20: 'add-message',
      21: 'edit-message',
      22: 'delete-message',

      // Reaction commands
      23: 'add-reaction',
      24: 'remove-reaction',

      // File and mention commands
      25: 'add-file',
      26: 'add-mention'
    };

    return commandMap[id] || `unknown-command-${id}`;
  }


  _getUpdateTypesByCommandId(id) {
    // Maps command IDs to the data types they affect
    const updateMap = {
      // Writer management affects writers
      0: ['writers'],
      1: ['writers'],

      // Invite management affects invites
      2: ['invites'],

      // Room commands affect room data
      3: ['room'],
      4: ['room'],

      // Member commands affect members
      5: ['members'],
      6: ['members'],
      7: ['members'],

      // Role commands affect roles
      8: ['roles'],
      9: ['roles'],
      10: ['roles'],

      // Permission commands affect permissions
      11: ['permissions'],

      // Channel commands affect channels
      12: ['channels'],
      13: ['channels'],
      14: ['channels'],

      // Category commands affect categories
      15: ['categories'],
      16: ['categories'],
      17: ['categories'],

      // Thread commands affect threads
      18: ['threads'],
      19: ['threads'],

      // Message commands affect messages
      20: ['messages'],
      21: ['messages'],
      22: ['messages'],

      // Reaction commands affect reactions
      23: ['reactions'],
      24: ['reactions'],

      // File and mention commands affect files and mentions
      25: ['files'],
      26: ['mentions']
    };

    return updateMap[id] || [];
  }

  // Open method
  async _open() {
    await this.base.ready()

    await this._loadRoomData()

    // Set up replication if enabled
    if (this.replicate) await this._replicate()


    // Set up file storage core if needed


    // Set up event listeners for propagation to owner if available
    this._setupEventPropagation()
  }

  // Set up event propagation to owner (GigaUser)
  _setupEventPropagation() {
    if (!this.owner) return
  }

  async _refreshRoom() {
    try {
      const roomData = await this.base.view.findOne('@gigaroom/room', {});
      if (roomData) {
        this.id = roomData.id;
        this.name = roomData.name;
        this.description = roomData.description;
        this.createdBy = roomData.createdBy;
        this.createdAt = roomData.createdAt;
        this.isPrivate = roomData.isPrivate;
        this.isEncrypted = roomData.isEncrypted;
        // Update other fields as needed
      }
      return roomData;
    } catch (error) {
      console.error('Error refreshing room data:', error);
      this.emit('error', error);
      return null;
    }
  }

  async _refreshMembers() {
    try {
      this._members = [];
      const membersStream = this.base.view.find('@gigaroom/member', {});
      for await (const member of membersStream) {
        this._members.push(member);
      }
      return this._members;
    } catch (error) {
      console.error('Error refreshing members:', error);
      this.emit('error', error);
      return [];
    }
  }

  async _refreshChannels() {
    await this.base.ready()
    try {
      const newChannels = [];
      const channelsStream = this.base.view.find('@gigaroom/channel', {});
      for await (const channel of channelsStream) {
        newChannels.push(channel);
      }
      // Sort channels by position
      newChannels.sort((a, b) => (a.position || 0) - (b.position || 0));
      this._channels = newChannels;
    } catch (error) {
      console.error('Error refreshing channels:', error);
      this.emit('error', error);
      return [];
    }
  }

  async _refreshCategories() {
    try {
      this._categories = [];
      const categoriesStream = this.base.view.find('@gigaroom/category', {});
      for await (const category of categoriesStream) {
        this._categories.push(category);
      }
      return this._categories;
    } catch (error) {
      console.error('Error refreshing categories:', error);
      this.emit('error', error);
      return [];
    }
  }

  async _refreshRoles() {
    try {
      this._roles = [];
      const rolesStream = this.base.view.find('@gigaroom/role', {});
      for await (const role of rolesStream) {
        this._roles.push(role);
      }
      return this._roles;
    } catch (error) {
      console.error('Error refreshing roles:', error);
      this.emit('error', error);
      return [];
    }
  }

  // Load room data from database
  async _loadRoomData() {
    await this.base.ready()
    await this._refreshRoom()
    await this._refreshChannels()
    await this._refreshRoles()
    await this._refreshMembers()
    await this._refreshCategories()

  }

  async forceUpdate() {
    if (!this.id) return;
    console.log(`Forcing update for room ${this.id}`)
    try {
      await this.base.ready()
      await this._loadRoomData()
      return true
    } catch (err) {
      console.error('Error during force update:', err)
      return false
    }
  }

  // Replication method
  async _replicate() {
    if (!this.base.discoveryKey) {
      console.error('Cannot replicate: missing discovery key')
      return
    }

    await this.base.ready()
    if (this.swarm === null) {
      this.swarm = new Hyperswarm({
        keyPair: await this.store.createKeyPair('hyperswarm'),
        bootstrap: this.bootstrap
      })
      this.swarm.on('connection', (connection, peerInfo) => {
        console.log(`Room ${this.id} connected to peer: ${peerInfo.publicKey.toString('hex').substring(0, 8)}`)
        connection.on('error', (err) => {
          console.error(`Connection error in room ${this.id}:`, err)
        })

        try {
          this.store.replicate(connection)
        } catch (err) {
          console.error(`Replication error in room ${this.id}:`, err)
        }
      })
    }

    this.pairing = new BlindPairing(this.swarm)
    this.member = this.pairing.addMember({
      discoveryKey: this.base.discoveryKey,
      onadd: async (candidate) => {
        try {
          const id = candidate.inviteId
          // Find the invite in the database
          let inv = null
          try {
            const stream = this.base.view.find('@gigaroom/invite', {})
            for await (const invite of stream) {
              if (b4a.equals(invite.id, id)) {
                inv = invite
                break
              }
            }
          } catch (err) {
            console.error('Error finding invite:', err)
          }

          // Check if invite exists and is valid
          if (!inv) return

          // Check if invite is expired
          const now = Date.now()
          if (inv.expires && inv.expires < now) return

          // Open the candidate and add the writer
          candidate.open(inv.publicKey)
          await this.addWriter(candidate.userData)
          candidate.confirm({
            key: this.base.key,
            encryptionKey: this.base.encryptionKey
          })
        } catch (err) {
          console.error('Error in member.onadd:', err)
        }
      }
    })

    console.log(`Room ${this.id} with namespace: ${this.namespace} joining swarm with discovery key: ${this.base.discoveryKey.toString('hex').substring(0, 8)}`)
    // Join the swarm with the room's discovery key
    this.swarm.join(this.base.discoveryKey)
  }

  // Close method
  async _close() {
    if (this.swarm) {
      if (this.member) await this.member.close()
      if (this.pairing) await this.pairing.close()
      await this.swarm.destroy()
    }
    if (this.base) await this.base.close()
  }

  // Helper method for parsing JSON safely
  _safeParseJSON(jsonStr, defaultValue = null) {
    if (!jsonStr) return defaultValue
    try {
      return JSON.parse(jsonStr)
    } catch (err) {
      console.error('JSON parsing error:', err)
      return defaultValue
    }
  }

  // Create a new room
  async initRoomParams(roomData, creatorPublicKey) {
    await this.base.ready()
    if (!roomData.name) throw new Error('Room name is required')

    this.id = roomData.id
    this.name = roomData.name
    this.description = roomData.description
    // Create room object
    const room = {
      id: roomData.id,
      type: roomData.type || 'channel',
      name: roomData.name,
      description: roomData.description || '',
      avatar: roomData.avatar || '',
      createdAt: Date.now(),
      createdBy: creatorPublicKey,
      discoveryKey: this.base.discoveryKey,
      coreKey: this.base.key,
      isPrivate: roomData.isPrivate || false,
      isEncrypted: roomData.isEncrypted || false,
      settings: JSON.stringify(roomData.settings || {}),
    }

    console.log('Appending room - dispatch @gigaroom/create-room', room)
    // Create the room first
    await this.base.append(dispatch('@gigaroom/create-room', room))

    // Wait a moment to ensure room is initialized
    await new Promise(resolve => setTimeout(resolve, 200))
    // Ensure the room ID is set
    console.log('Creating default channels')
    console.log('Adding creator as admin')
    // Add the creator as admin memberp
    await this.addMember({
      userKey: creatorPublicKey,
      displayName: roomData.creatorDisplayName || 'Admin',
      roles: JSON.stringify(['admin'])
    })
    console.log('Creator marked as admin')

    // Reload room data again
    await this._loadRoomData()

    return this.id
  }

  async updateRoom(roomData) {
    if (!this.id) throw new Error('Room not initialized');

    // Ensure we have all required fields
    const updatedRoom = {
      id: this.id,
      type: roomData.type || 'community',
      name: roomData.name || this.name,
      description: roomData.description || this.description,
      avatar: roomData.avatar || null,
      createdAt: this.createdAt,
      createdBy: this.createdBy,
      discoveryKey: this.base.discoveryKey,
      coreKey: this.base.key,
      isPrivate: roomData.isPrivate !== undefined ? roomData.isPrivate : this.isPrivate,
      isEncrypted: roomData.isEncrypted !== undefined ? roomData.isEncrypted : this.isEncrypted,
      settings: roomData.settings ? JSON.stringify(roomData.settings) : null
    };

    // Use the safe dispatch method
    await this._safeDispatch('@gigaroom/update-room', updatedRoom);

    // Refresh room data
    await this._refreshRoom();

    return this.id;
  }

  // Add a writer to the room
  async addWriter(key) {
    await this.base.append(dispatch('@gigaroom/add-writer', { key: b4a.isBuffer(key) ? key : b4a.from(key) }))
    return true
  }

  // Remove a writer from the room
  async removeWriter(key) {
    await this.base.append(dispatch('@gigaroom/remove-writer', { key: b4a.isBuffer(key) ? key : b4a.from(key) }))
  }

  // Create a room invite
  async createInvite(opts = {}) {
    // Create a new invite using blind-pairing
    const { id, invite, publicKey, expires } = BlindPairing.createInvite(this.base.key)

    // Prepare invite record
    const record = {
      id,
      invite,
      publicKey,
      expires: opts.expires || (Date.now() + 24 * 60 * 60 * 1000), // Default 24h expiry
      roomId: this.id,
      maxUses: opts.maxUses || 0,
      useCount: 0,
      isRevoked: false
    }

    // Store the invite
    await this.base.append(dispatch('@gigaroom/add-invite', record))

    // Return encoded invite string
    return z32.encode(record.invite)
  }

  // Create a channel in the room 
  async createChannel(channelData, creatorPublicKey = null) {
    if (!creatorPublicKey) {
      if (this.owner && this.owner.publicKey) {
        creatorPublicKey = this.owner.publicKey
      } else {
        throw new Error("No public key found for channel creation")
      }
    }
    console.log('Creating channel - Start')
    console.log('Current room state:', {
      id: this.id,
      name: this.name,
      base: !!this.base,
      baseReady: this.base ? await this.base.ready() : 'No base'
    })

    if (!channelData.name) {
      console.error('Channel name is required')
      throw new Error('Channel name is required')
    }

    // Convert creatorPublicKey to hex string
    const creatorPublicKeyStr = Buffer.isBuffer(creatorPublicKey)
      ? creatorPublicKey.toString('hex')
      : creatorPublicKey

    console.log('Creator public key:', creatorPublicKeyStr)

    // Generate a unique channel ID
    const channelId = crypto.randomBytes(8).toString('hex')

    // Get the highest position to place the new channel at the end
    let position = 0
    try {
      const channels = this._channels

      if (channels.length > 0) {
        const highestPos = Math.max(...channels.map(c => c.position))
        position = highestPos + 1
      }
    } catch (err) {
      console.error('Error getting channel position:', err)
    }


    // Create channel object
    const channel = {
      id: channelId,
      roomId: this.id,
      type: channelData.type || 'text',
      name: channelData.name,
      topic: channelData.topic || '',
      position: channelData.position !== undefined ? channelData.position : position,
      categoryId: channelData.categoryId || null,
      createdAt: Date.now(),
      createdBy: creatorPublicKeyStr, // Use hex string instead of buffer
      isDefault: channelData.isDefault || false,
      settings: JSON.stringify(channelData.settings || {})
    }

    try {
      // Create the channel
      await this.base.append(dispatch('@gigaroom/create-channel', channel))
      console.log('Channel appended to base')
      return channelId
    } catch (error) {
      console.error('Error in createChannel:', error)
      throw error
    }
  }



  // Add a member to the room
  async addMember(memberData) {
    if (!this.id) {
      await this._refreshRoom()
    }
    if (!memberData.userKey) throw new Error('User key is required')

    // Ensure userKey is a buffer
    const userKey = Buffer.isBuffer(memberData.userKey)
      ? memberData.userKey
      : Buffer.from(memberData.userKey, 'hex')

    // Generate a unique member ID
    const memberId = crypto.randomBytes(8).toString('hex')

    // Create member object with explicit string conversions
    const member = {
      id: memberId,
      roomId: this.id,
      userKey: userKey, // Ensure this is a buffer
      displayName: memberData.displayName || 'Member',
      joinedAt: Date.now(),
      invitedBy: memberData.invitedBy || null,
      lastActivity: Date.now(),
      status: memberData.status || 'active',
      lastReadId: null,
      // Ensure roles is a JSON string
      roles: typeof memberData.roles === 'string'
        ? memberData.roles
        : JSON.stringify(memberData.roles || ['member'])
    }

    console.log('Adding member:', member)

    try {
      // Add the member
      await this.base.append(dispatch('@gigaroom/add-member', member))
      console.log('Member added to base')

      // Also add as writer if not already
      try {
        await this.addWriter(userKey)
      } catch (err) {
        console.error('Error adding writer:', err)
      }

      // Reload room data
      await this._loadRoomData()
      console.log('Room data reloaded after adding member')

      return memberId
    } catch (error) {
      console.error('Error in addMember:', error)
      throw error
    }
  }

  // Remove a member from the room
  async removeMember(memberId) {
    if (!this.id) throw new Error('Room not initialized')

    // Find the member to get their key
    const member = this._members.find(m => m.id === memberId)
    if (!member) throw new Error('Member not found')

    // Remove the member
    await this.base.append(dispatch('@gigaroom/remove-member', { id: memberId }))

    // Optionally remove as writer
    // Note: We might want to keep them as a writer if they have other memberships
    // await this.removeWriter(member.userKey)

    // Reload room data
    await this._loadRoomData()

    return true
  }

  async getRoomData() {
    const roomData = await this.base.view.findOne('@gigaroom/room', {})
    if (roomData) {
      this.id = roomData.id
      // Load other fields
      this.name = roomData.name
      this.description = roomData.description
      this.createdBy = roomData.createdBy
      this.createdAt = roomData.createdAt
      this.isPrivate = roomData.isPrivate
      this.isEncrypted = roomData.isEncrypted
    }
    return roomData
  }

  // Join a room using an invite
  static async joinRoom(store, inviteCode, opts = {}) {
    try {
      const pairer = GigaRoom.pair(store, inviteCode, opts)

      const pairingPromise = pairer.finished()
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Room joining timed out')), 30000)
      )

      const room = await Promise.race([pairingPromise, timeoutPromise])
      await room.ready()

      // Enhanced member addition
      if (opts.userKey) {
        try {
          await room.addMember({
            userKey: opts.userKey,
            displayName: opts.displayName || 'New Member',
            // Optional: Add more metadata
            metadata: {
              joinMethod: 'invite',
              inviteUsed: inviteCode
            }
          })
        } catch (memberError) {
          console.error('Error adding member:', memberError)
          // Optionally: Implement member addition retry or fallback
        }
      }

      return room
    } catch (err) {
      console.error('Comprehensive room joining error:', err)
      throw err
    }
  }

  // Static pair method
  static pair(store, invite, opts) {
    return new GigaRoomPairer(store, invite, opts)
  }


  // Update owner reference (for GigaUser to claim this room)
  setOwner(owner) {
    this.owner = owner
    this._setupEventPropagation()
    return this
  }

  // Getters for room data
  get members() {
    return this._members
  }

  get channels() {
    return this._channels.sort((a, b) => (a.position || 0) - (b.position || 0))
  }

  get categories() {
    return this._categories
  }

  get roles() {
    return this._roles
  }

  get settings() {
    return this._settings
  }

  // Get serializable room info for storing in GigaUser
  get roomInfo() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      key: this.key ? (Buffer.isBuffer(this.key) ? this.key.toString('hex') : this.key) : null,
      discoveryKey: this.discoveryKey ? (Buffer.isBuffer(this.discoveryKey) ? this.discoveryKey.toString('hex') : this.discoveryKey) : null,
      createdAt: this.createdAt,
      memberCount: this._members.length,
      lastAccessed: Date.now()
    }
  }
}

function noop(err) {
  if (err) console.error('Operation error:', err)
}

module.exports = GigaRoom
