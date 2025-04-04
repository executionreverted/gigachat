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
const { getEncoding } = require('./spec/hyperdispatch/messages.js')
const sodium = require('sodium-native')
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

    this.stateUpdateInterval = opts.stateUpdateInterval || 4000 // 4 seconds default
    this._intervalTimer = null
    this._lastUpdateTime = {
      room: 0,
      channels: 0,
      members: 0,
      categories: 0,
      roles: 0
    }



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


    this.router.add('@gigaroom/add-message', async (data, context) => {
      // Verify the message signature before adding to the database
      if (!this._verifyMessageSignature(data)) {
        console.warn('Rejected message with invalid signature:', data.id);
        return; // Don't add invalid messages
      }

      console.log('Message is signed by a valid user')
      // If signature is valid, add to the database
      await context.view.insert('@gigaroom/message', data);

      // Update search index if needed
      // this._updateSearchIndex(data);
    });

    // Edit message handler with verification
    this.router.add('@gigaroom/edit-message', async (data, context) => {
      // Verify the message signature
      if (!this._verifyMessageSignature(data)) {
        console.warn('Rejected message edit with invalid signature:', data.id);
        return;
      }
      // Get the original message
      const originalMessage = await context.view.findOne('@gigaroom/message', { id: data.id });

      // Verify the editor is the original sender
      if (originalMessage && !this._verifyMessageSender(originalMessage, data.sender)) {
        console.warn('Rejected message edit from non-author:', data.id);
        return;
      }

      data.channelId = originalMessage.channelId

      try {
        console.log('Edit signed by original sender')
        // Delete the old message
        await context.view.delete('@gigaroom/message', { id: data.id });
      } catch (e) {
        console.log(e)
        // Ignore deletion errors
      }

      console.log('Inserting edited message')
      // Insert the updated message
      await context.view.insert('@gigaroom/message', data);
    });

    // Delete message handler
    this.router.add('@gigaroom/delete-message', async (data, context) => {
      // Get the original message
      const originalMessage = await context.view.findOne('@gigaroom/message', { id: data.id });

      if (!originalMessage) {
        return; // Message doesn't exist
      }

      // Only allow deletion by the original sender or moderators
      // This permission check should be enhanced for production
      const isOriginalSender = this._verifyMessageSender(originalMessage, data.deletedBy);

      if (!isOriginalSender) {
        // Check if the deleter has moderation permissions
        // const hasModerationPermission = await this._userHasPermission(data.deletedBy, 'MANAGE_MESSAGES');
        // if (!hasModerationPermission) {
        //   console.warn('Rejected message deletion from unauthorized user:', data.id);
        //   return;
        // }
      }

      try {
        // Delete the message
        await context.view.delete('@gigaroom/message', { id: data.id });

        // Insert tombstone record for synchronization
        await context.view.insert('@gigaroom/message', {
          ...originalMessage,
          deleted: true,
          deletedBy: data.deletedBy,
          deletedAt: data.deletedAt,
          content: '' // Clear content for privacy
        });
      } catch (e) {
        console.error('Error deleting message:', e);
      }
    });

    // Reaction handlers
    this.router.add('@gigaroom/add-reaction', async (data, context) => {
      await context.view.insert('@gigaroom/reaction', data);
    });

    this.router.add('@gigaroom/remove-reaction', async (data, context) => {
      try {
        await context.view.delete('@gigaroom/reaction', { id: data.id });
      } catch (e) {
        console.error('Error removing reaction:', e);
      }
    });

    // Add more empty handlers for other commands in the schema
    // This prevents the "Missing handler" error while providing a basic implementation
    const placeholderCommands = [
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

        if (commandId == 'edit-message') {
          console.log('Applied a edit-message state change')
          this.emit('message-edited')
        }

        // Emit a command-specific event with node data
        this.emit(`command:${command}`, node.value);
      } catch (error) {
        console.error(`Error processing command in GigaRoom:`, error);
        this.emit('error', error);
      }
    }

    // Ensure the view is flushed
    await view.flush();

    // First refresh all data before emitting events
    const refreshPromises = [];

    // Room data
    if (updates.room) {
      refreshPromises.push(this._refreshRoom());
    }

    // Members 
    if (updates.members) {
      refreshPromises.push(this._refreshMembers());
    }

    // Channels
    if (updates.channels) {
      refreshPromises.push(this._refreshChannels());
    }

    // Categories
    if (updates.categories) {
      refreshPromises.push(this._refreshCategories());
    }

    // Roles
    if (updates.roles) {
      refreshPromises.push(this._refreshRoles());
    }

    // Wait for all refresh operations to complete
    await Promise.all(refreshPromises);

    // Emit events with refreshed data
    if (updates.room) {
      this.emit('room:updated', this.id);
    }

    if (updates.members) {
      this.emit('members:updated', this._members);
    }

    if (updates.channels) {
      this.emit('channels:updated', this._channels);
    }

    if (updates.categories) {
      this.emit('categories:updated', this._categories);
    }

    if (updates.roles) {
      this.emit('roles:updated', this._roles);
    }

    // Other data types
    if (updates.messages) this.emit('messages:updated');
    if (updates.files) this.emit('files:updated');
    if (updates.reactions) this.emit('reactions:updated');
    if (updates.invites) this.emit('invites:updated');
    if (updates.permissions) this.emit('permissions:updated');
    if (updates.threads) this.emit('threads:updated');

    // Emit a general update event
    this.emit('update');

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
    await this._replicate()


    // Set up file storage core if needed


    // Set up event listeners for propagation to owner if available
    this._setupEventPropagation()
    this._startStateUpdateInterval()
  }

  // Set up event propagation to owner (GigaUser)
  _setupEventPropagation() {
    if (!this.owner) return
  }

  async refreshState() {
    // This method refreshes all state for immediate consistency
    await Promise.all([
      this._refreshRoom(),
      this._refreshChannels(),
      this._refreshMembers(),
      this._refreshCategories(),
      this._refreshRoles()
    ])

    // Emit an event to signal that state has been refreshed
    this.emit('state:refreshed', {
      roomId: this.id,
      channelCount: this._channels.length,
      memberCount: this._members.length
    })

    return {
      room: {
        id: this.id,
        name: this.name,
        description: this.description
      },
      channels: this._channels,
      members: this._members,
      categories: this._categories,
      roles: this._roles
    }
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

      this._lastUpdateTime.room = Date.now()
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

      this._lastUpdateTime.members = Date.now()
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

      try {
        for await (const channel of channelsStream) {
          newChannels.push(channel);
        }
        // Sort channels by position
        newChannels.sort((a, b) => (a.position || 0) - (b.position || 0));

        // Only update and emit event if channel list actually changed
        const previousChannelIds = this._channels.map(c => c.id).sort().join(',');
        const newChannelIds = newChannels.map(c => c.id).sort().join(',');

        if (previousChannelIds !== newChannelIds || this._channels.length !== newChannels.length) {
          // Channel list has changed
          this._channels = newChannels;
          this.emit('channels:updated', this._channels);
        }

        this._lastUpdateTime.channels = Date.now()
        return this._channels;
      } catch (streamError) {
        console.error('Error processing channel stream:', streamError);
        // Don't update channels on stream error, but don't throw
        return this._channels;
      }
    } catch (error) {
      console.error('Error refreshing channels:', error);
      this.emit('error', error);
      return this._channels;
    }
  }

  async _refreshCategories() {
    try {
      this._categories = [];
      const categoriesStream = this.base.view.find('@gigaroom/category', {});
      for await (const category of categoriesStream) {
        this._categories.push(category);
      }

      this._lastUpdateTime.categories = Date.now()
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

      this._lastUpdateTime.roles = Date.now()
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

      const kp = await this.store.createKeyPair('hyperswarm')
      console.log('err keypair created by ' + this.id, JSON.stringify(kp))
      this.swarm = new Hyperswarm({
        keyPair: kp,
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

    this._stopStateUpdateInterval()
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

    if (!channelData.name) {
      console.error('Channel name is required')
      throw new Error('Channel name is required')
    }

    // Convert creatorPublicKey to hex string
    const creatorPublicKeyStr = Buffer.isBuffer(creatorPublicKey)
      ? creatorPublicKey.toString('hex')
      : creatorPublicKey

    // Generate a unique channel ID
    const channelId = crypto.randomBytes(8).toString('hex')

    // Get the highest position to place the new channel at the end
    let position = 0
    try {
      // Ensure we have the latest channels data
      await this._refreshChannels()
      const channels = this._channels

      if (channels.length > 0) {
        const highestPos = Math.max(...channels.map(c => c.position || 0))
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

      // Update local channel list immediately
      await this._refreshChannels()

      // Emit specific channel creation event
      this.emit('channel:created', {
        channelId: channelId,
        name: channelData.name
      })

      return channelId
    } catch (error) {
      console.error('Error in createChannel:', error)
      throw error
    }
  }

  /**
   * Send a message to a channel in the room
   * @param {String} channelId - The ID of the channel
   * @param {String} content - The message content
   * @param {Object} opts - Optional parameters
   * @returns {Promise<String>} - The ID of the new message
   */
  async sendMessage(channelId, content, opts = {}) {
    // Ensure room is ready
    await this.base.ready();

    // Validate inputs
    if (!channelId) throw new Error('Channel ID is required');
    if (!content) throw new Error('Message content is required');
    if (!this.owner || !this.owner.publicKey) {
      throw new Error('Cannot send message: Not authenticated');
    }

    // Generate unique message ID
    const messageId = crypto.randomBytes(8).toString('hex');

    // Create message object
    const message = {
      id: messageId,
      roomId: this.id,
      channelId: channelId,
      type: opts.type || 'text',
      sender: Buffer.isBuffer(this.owner.publicKey) ?
        this.owner.publicKey :
        Buffer.from(this.owner.publicKey, 'hex'),
      senderName: this.owner.profile?.name || 'Unknown User',
      content: content,
      timestamp: Date.now(),
      status: 'sent',
      edited: false,
      replyToId: opts.replyToId || null,
      threadRootId: opts.threadRootId || opts.replyToId || null, // Start thread if replying
      searchableText: content // Basic searchable text (could be enhanced)
    };

    // Sign the message
    message.signature = this._signMessage(message);

    // Append to the room's log
    await this.base.append(dispatch('@gigaroom/add-message', message));

    // Emit a local event for immediate UI updates
    this.emit('message:sent', {
      messageId,
      channelId,
      timestamp: message.timestamp
    });

    return messageId;
  }

  /**
   * Edit an existing message
   * @param {String} messageId - The ID of the message to edit
   * @param {String} newContent - The new content for the message
   * @returns {Promise<Boolean>} - Whether the edit was successful
   */
  async editMessage(messageId, newContent) {
    await this.base.ready();

    // Find the original message
    const originalMessage = await this.getMessage(messageId);

    if (!originalMessage) {
      throw new Error(`Message not found: ${messageId}`);
    }

    // Check authorization - only the sender can edit
    if (!this._canEditMessage(originalMessage)) {
      throw new Error('Not authorized to edit this message');
    }

    // Create updated message object
    const updatedMessage = {
      ...originalMessage,
      content: newContent,
      edited: true,
      editedAt: Date.now(),
      searchableText: newContent // Update searchable text
    };

    // Sign the updated message
    updatedMessage.signature = this._signMessage(updatedMessage);

    // Update in the database
    await this.base.append(dispatch('@gigaroom/edit-message', updatedMessage));

    console.log('Edited message in db')
    // Emit edit event
    this.emit('message:edited', {
      messageId,
    });

    return true;
  }

  /**
   * Check if the current user can edit a message
   * @private
   * @param {Object} message - The message to check
   * @returns {Boolean} - Whether the user can edit the message
   */
  _canEditMessage(message) {
    // Check if the user is the sender
    const isSender = Buffer.isBuffer(message.sender) && this.owner?.publicKey ?
      message.sender.equals(this.owner.publicKey) :
      message.sender === this.owner?.publicKey?.toString('hex');

    // Add permission check for admins/mods later
    // const isAdmin = this._userHasPermission('MANAGE_MESSAGES');

    return isSender; // || isAdmin
  }

  /**
   * Delete a message
   * @param {String} messageId - The ID of the message to delete
   * @param {Object} opts - Optional parameters
   * @returns {Promise<Boolean>} - Whether the deletion was successful
   */
  async deleteMessage(messageId, opts = {}) {
    await this.base.ready();

    // Find the original message
    const message = await this.getMessage(messageId);

    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }

    // Check authorization - only the sender can delete, unless force=true (for moderation)
    if (!opts.force && !this._canEditMessage(message)) {
      throw new Error('Not authorized to delete this message');
    }

    // Create deletion record
    const deletionRecord = {
      id: message.id,
      deleted: true,
      deletedBy: Buffer.isBuffer(this.owner.publicKey) ?
        this.owner.publicKey :
        Buffer.from(this.owner.publicKey, 'hex'),
      deletedAt: Date.now()
    };

    // Delete in the database
    await this.base.append(dispatch('@gigaroom/delete-message', deletionRecord));

    // Emit deletion event
    this.emit('message:deleted', {
      messageId,
      channelId: message.channelId
    });

    return true;
  }

  /**
   * Get a single message by ID
   * @param {String} messageId - The ID of the message
   * @returns {Promise<Object>} - The message object
   */
  async getMessage(messageId) {
    await this.base.ready();

    try {
      return await this.base.view.findOne('@gigaroom/message', { id: messageId });
    } catch (error) {
      console.error(`Error retrieving message ${messageId}:`, error);
      await this.base.update()
      return null;
    }
  }

  /**
   * Get messages for a channel with pagination
   * @param {String} channelId - The channel ID
   * @param {Object} opts - Options for pagination and filtering
   * @returns {Promise<Array>} - Array of messages
   */
  async getMessages(channelId, opts = {}) {
    await this.base.ready();

    const limit = opts.limit || 50;
    const before = opts.before || Date.now();
    const after = opts.after || 0;

    try {
      const messages = [];
      // In a real implementation, you might want to use a more efficient query
      // This is a basic implementation that fetches all messages and filters them
      const messageStream = this.base.view.find('@gigaroom/message', {});

      for await (const message of messageStream) {
        if (message.channelId === channelId &&
          message.timestamp > after &&
          message.timestamp < before &&
          !message.deleted) {
          messages.push(message);
        }

        // Stop if we've reached the limit
        if (messages.length >= limit) break;
      }

      // Sort messages by timestamp
      messages.sort((a, b) => a.timestamp - b.timestamp);

      return messages;
    } catch (error) {
      console.error(`Error retrieving messages for channel ${channelId}:`, error);
      return [];
    }
  }

  /**
   * Get messages from a thread
   * @param {String} threadRootId - The root message ID of the thread
   * @param {Object} opts - Options for pagination and filtering
   * @returns {Promise<Array>} - Array of thread messages
   */
  async getThreadMessages(threadRootId, opts = {}) {
    await this.base.ready();

    const limit = opts.limit || 50;
    const before = opts.before || Date.now();
    const after = opts.after || 0;

    try {
      const messages = [];
      // In a real implementation, you might want to use a more efficient query
      const messageStream = this.base.view.find('@gigaroom/message', {});

      for await (const message of messageStream) {
        if (message.threadRootId === threadRootId &&
          message.timestamp > after &&
          message.timestamp < before &&
          !message.deleted) {
          messages.push(message);
        }

        // Stop if we've reached the limit
        if (messages.length >= limit) break;
      }

      // Sort messages by timestamp
      messages.sort((a, b) => a.timestamp - b.timestamp);

      return messages;
    } catch (error) {
      console.error(`Error retrieving thread messages for ${threadRootId}:`, error);
      return [];
    }
  }



  /**
   * Add a reaction to a message
   * @param {String} messageId - The message ID
   * @param {String} emoji - The emoji to add as reaction
   * @returns {Promise<String>} - The ID of the new reaction
   */
  async addReaction(messageId, emoji) {
    await this.base.ready();

    // Validate inputs
    if (!messageId) throw new Error('Message ID is required');
    if (!emoji) throw new Error('Emoji is required');

    // Generate unique reaction ID
    const reactionId = crypto.randomBytes(8).toString('hex');

    // Create reaction object
    const reaction = {
      id: reactionId,
      messageId: messageId,
      emoji: emoji,
      user: this.owner.publicKey,
      timestamp: Date.now()
    };

    // Add to the database
    await this.base.append(dispatch('@gigaroom/add-reaction', reaction));

    // Emit reaction event
    this.emit('reaction:added', {
      reactionId,
      messageId,
      emoji
    });

    return reactionId;
  }

  /**
   * Remove a reaction from a message
   * @param {String} messageId - The message ID
   * @param {String} emoji - The emoji to remove
   * @returns {Promise<Boolean>} - Whether the removal was successful
   */
  async removeReaction(messageId, emoji) {
    await this.base.ready();

    // Find the user's reaction
    const reactions = await this.getReactions(messageId);
    const userReaction = reactions.find(r =>
      r.emoji === emoji &&
      (Buffer.isBuffer(r.user) ?
        r.user.equals(this.owner.publicKey) :
        r.user === this.owner.publicKey.toString('hex'))
    );

    if (!userReaction) {
      throw new Error('Reaction not found');
    }

    // Create removal record
    const removalRecord = {
      id: userReaction.id
    };

    // Remove from the database
    await this.base.append(dispatch('@gigaroom/remove-reaction', removalRecord));

    // Emit reaction removed event
    this.emit('reaction:removed', {
      messageId,
      emoji
    });

    return true;
  }

  /**
   * Get reactions for a message
   * @param {String} messageId - The message ID
   * @returns {Promise<Array>} - Array of reactions
   */
  async getReactions(messageId) {
    await this.base.ready();

    try {
      const reactions = [];
      const reactionStream = this.base.view.find('@gigaroom/reaction', {});

      for await (const reaction of reactionStream) {
        if (reaction.messageId === messageId) {
          reactions.push(reaction);
        }
      }

      return reactions;
    } catch (error) {
      console.error(`Error retrieving reactions for message ${messageId}:`, error);
      return [];
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

    try {
      // Add the member
      await this.base.append(dispatch('@gigaroom/add-member', member))

      // Also add as writer if not already
      try {
        await this.addWriter(userKey)
      } catch (err) {
        console.error('Error adding writer:', err)
      }

      // Reload room data immediately
      await this._refreshMembers()

      // Emit specific member added event
      this.emit('member:added', {
        memberId: memberId,
        displayName: member.displayName
      })

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

    console.log(`Room ${this.id}: State update interval started (${this.stateUpdateInterval}ms)`)
  }

  /**
   * Stops the state update interval
   * @private
   */
  _stopStateUpdateInterval() {
    if (this._intervalTimer) {
      clearInterval(this._intervalTimer)
      this._intervalTimer = null
      console.log(`Room ${this.id}: State update interval stopped`)
    }
  }

  /**
   * Refreshes and emits all state data
   * @private
   */
  async _emitLatestStates() {
    try {
      // Skip if not ready or closed
      if (!this.opened || this.closing) return

      const now = Date.now()
      const refreshPromises = []

      // Only refresh data that hasn't been updated in the last interval
      // This prevents unnecessary refreshes if data was just updated
      if (now - this._lastUpdateTime.room > this.stateUpdateInterval) {
        refreshPromises.push(this._refreshAndEmitRoom())
      }

      if (now - this._lastUpdateTime.channels > this.stateUpdateInterval) {
        refreshPromises.push(this._refreshAndEmitChannels())
      }

      if (now - this._lastUpdateTime.members > this.stateUpdateInterval) {
        refreshPromises.push(this._refreshAndEmitMembers())
      }

      if (now - this._lastUpdateTime.categories > this.stateUpdateInterval) {
        refreshPromises.push(this._refreshAndEmitCategories())
      }

      if (now - this._lastUpdateTime.roles > this.stateUpdateInterval) {
        refreshPromises.push(this._refreshAndEmitRoles())
      }

      // Wait for all refreshes to complete
      await Promise.all(refreshPromises)

      // Emit a combined state update event with all the latest data
      this.emit('state:periodic-update', {
        timestamp: now,
        room: {
          id: this.id,
          name: this.name,
          description: this.description
        },
        channels: this._channels,
        members: this._members,
        categories: this._categories,
        roles: this._roles
      })

    } catch (error) {
      console.error(`Room ${this.id}: Error in periodic state update:`, error)
      this.emit('error', error)
    }
  }

  /**
   * Refreshes room data and emits an event if changed
   * @private
   */
  async _refreshAndEmitRoom() {
    try {
      // Store the original values for comparison
      const originalRoom = {
        id: this.id,
        name: this.name,
        description: this.description
      }
      const originalRoomStr = JSON.stringify(originalRoom)

      // Refresh the data
      await this._refreshRoom()

      // Update the last update time
      this._lastUpdateTime.room = Date.now()

      // Check if the value changed
      const newRoom = {
        id: this.id,
        name: this.name,
        description: this.description
      }
      const newRoomStr = JSON.stringify(newRoom)

      if (originalRoomStr !== newRoomStr) {
        // Only emit if there was a change
        this.emit('room:updated', this.id)
      }

      return true
    } catch (error) {
      console.error(`Room ${this.id}: Error refreshing room data:`, error)
      return false
    }
  }

  /**
   * Refreshes channels data and emits an event if changed
   * @private
   */
  async _refreshAndEmitChannels() {
    try {
      // Store the original value for comparison
      const originalChannelsIds = this._channels.map(c => c.id).sort().join(',')

      // Refresh the data
      await this._refreshChannels()

      // Update the last update time
      this._lastUpdateTime.channels = Date.now()

      // Check if the value changed - compare IDs for efficient change detection
      const newChannelsIds = this._channels.map(c => c.id).sort().join(',')

      if (originalChannelsIds !== newChannelsIds) {
        // Only emit if there was a change
        this.emit('channels:updated', this._channels)
      }

      return true
    } catch (error) {
      console.error(`Room ${this.id}: Error refreshing channels:`, error)
      return false
    }
  }

  /**
   * Refreshes members data and emits an event if changed
   * @private
   */
  async _refreshAndEmitMembers() {
    try {
      // Store the original value for comparison
      const originalMembersIds = this._members.map(m => m.id).sort().join(',')

      // Refresh the data
      await this._refreshMembers()

      // Update the last update time
      this._lastUpdateTime.members = Date.now()

      // Check if the value changed - compare IDs for efficient change detection
      const newMembersIds = this._members.map(m => m.id).sort().join(',')

      if (originalMembersIds !== newMembersIds) {
        // Only emit if there was a change
        this.emit('members:updated', this._members)
      }

      return true
    } catch (error) {
      console.error(`Room ${this.id}: Error refreshing members:`, error)
      return false
    }
  }

  /**
   * Refreshes categories data and emits an event if changed
   * @private
   */
  async _refreshAndEmitCategories() {
    try {
      // Store the original value for comparison
      const originalCategoriesIds = this._categories.map(c => c.id).sort().join(',')

      // Refresh the data
      await this._refreshCategories()

      // Update the last update time
      this._lastUpdateTime.categories = Date.now()

      // Check if the value changed - compare IDs for efficient change detection
      const newCategoriesIds = this._categories.map(c => c.id).sort().join(',')

      if (originalCategoriesIds !== newCategoriesIds) {
        // Only emit if there was a change
        this.emit('categories:updated', this._categories)
      }

      return true
    } catch (error) {
      console.error(`Room ${this.id}: Error refreshing categories:`, error)
      return false
    }
  }

  /**
   * Refreshes roles data and emits an event if changed
   * @private
   */
  async _refreshAndEmitRoles() {
    try {
      // Store the original value for comparison
      const originalRolesIds = this._roles.map(r => r.id).sort().join(',')

      // Refresh the data
      await this._refreshRoles()

      // Update the last update time
      this._lastUpdateTime.roles = Date.now()

      // Check if the value changed - compare IDs for efficient change detection
      const newRolesIds = this._roles.map(r => r.id).sort().join(',')

      if (originalRolesIds !== newRolesIds) {
        // Only emit if there was a change
        this.emit('roles:updated', this._roles)
      }

      return true
    } catch (error) {
      console.error(`Room ${this.id}: Error refreshing roles:`, error)
      return false
    }
  }



  /**
   * Signs message data with the user's private key
   * @private
   * @param {Object} messageData - The message data to sign
   * @returns {Buffer} - The signature
   */
  _signMessage(messageData) {
    if (!this.owner || !this.owner.keyPair || !this.owner.keyPair.secretKey) {
      throw new Error('Cannot sign message: Missing private key');
    }
    console.log("secret", this.owner.keyPair)

    // Create a deterministic representation of the message data for signing
    const signableData = this._prepareMessageForSigning(messageData);

    try {
      const signature = Buffer.alloc(sodium.crypto_sign_BYTES)
      sodium.crypto_sign_detached(signature, signableData, this.owner.keyPair.secretKey)
      return signature
    } catch (e) {
      console.log(e)
    }

  }

  /**
   * Convert a raw key to PEM format
   * @private
   * @param {Buffer} key - The raw key
   * @returns {String} - The key in PEM format
   */
  _convertToPEM(key) {
    const crypto = require('crypto');

    // This is a simplified approach that might need adjustment
    // based on your actual key format
    try {
      if (Buffer.isBuffer(key)) {
        // Try to determine if it's an RSA key
        if (key.length === 32) {
          // It might be an ed25519 key
          return key;
        } else {
          // Attempt to create a key object
          return crypto.createPrivateKey({
            key: key,
            format: 'der',
            type: 'pkcs8'
          });
        }
      } else if (typeof key === 'string') {
        // If it's already a string, it might be in PEM format
        if (key.includes('-----BEGIN')) {
          return key;
        } else {
          // Try to parse it as a DER-encoded key
          return crypto.createPrivateKey({
            key: Buffer.from(key, 'hex'),
            format: 'der',
            type: 'pkcs8'
          });
        }
      } else {
        throw new Error('Unsupported key format');
      }
    } catch (error) {
      console.error('Error converting key to PEM:', error);
      throw error;
    }
  }


  /**
   * Fallback signing method if crypto.sign is not available
   * @private
   */
  _fallbackSign(data, privateKey) {
    // Simple implementation using crypto module
    const sign = crypto.createSign('SHA256');
    sign.update(data);
    sign.end();
    return sign.sign(privateKey);
  }

  /**
   * Create a simple signature when more advanced methods fail
   * @private
   * @param {Buffer} data - The data to sign
   * @param {Buffer|String} secretKey - The secret key
   * @returns {Buffer} - The signature
   */
  _createSimpleSignature(data, secretKey) {

    // Ensure secretKey is a buffer
    const keyBuffer = Buffer.isBuffer(secretKey) ?
      secretKey :
      Buffer.from(secretKey, 'hex');

    // Create a HMAC using the secret key
    const hmac = crypto.createHmac('sha256', keyBuffer);
    hmac.update(data);

    // Return the digest as the signature
    return hmac.digest();
  }

  /**
 * Prepares message data for signing by creating a deterministic representation
 * @private
 * @param {Object} messageData - The message data
 * @returns {Buffer} - Deterministic representation for signing
 */
  _prepareMessageForSigning(messageData) {
    // Create a deterministic subset of the message for signing
    // This should include everything except the signature itself
    const signable = {
      id: messageData.id,
      roomId: messageData.roomId,
      channelId: messageData.channelId,
      type: messageData.type,
      content: messageData.content,
      sender: messageData.sender ?
        (Buffer.isBuffer(messageData.sender) ?
          messageData.sender.toString('hex') :
          messageData.sender) :
        null,
      timestamp: messageData.timestamp,
      threadRootId: messageData.threadRootId || null,
      replyToId: messageData.replyToId || null,
      edited: messageData.edited || false
    };

    // Convert to buffer for signing
    return Buffer.from(JSON.stringify(signable));
  }

  /**
 * Verifies a message signature
 * @param {Object} message - The message to verify
 * @returns {Boolean} - Whether the signature is valid
 */
  _verifyMessageSignature(message) {
    if (!message) return false;
    console.log('Verifying...')
    try {
      // If there's no signature or sender, the message is invalid
      if (!message.signature || !message.sender) {
        console.warn('Missing signature or sender in message');
        return false;
      }

      // Convert string signature to buffer if needed
      const signatureBuffer = typeof message.signature === 'string' ?
        Buffer.from(message.signature, 'hex') :
        message.signature;

      // Convert string sender to buffer if needed  
      const senderKeyBuffer = typeof message.sender === 'string' ?
        Buffer.from(message.sender, 'hex') :
        message.sender;

      // Prepare the message data for verification (same format as when signing)
      const signableData = this._prepareMessageForSigning(message);

      try {
        const valid = sodium.crypto_sign_verify_detached(message.signature, signableData, message.sender)
        console.log({ valid })
        return valid
      } catch (error) {
        console.error('Error during normal signature verification:', error);
        // Fall back to HMAC verification
        return false
      }
    } catch (error) {
      console.error('Error verifying message signature:', error);
      return false;
    }
  }

  /**
   * Verify that the sender of an edit/delete is the original sender
   * @private
   * @param {Object} originalMessage - The original message
   * @param {Buffer|String} sender - The sender's public key
   * @returns {Boolean} - Whether the sender is authorized
   */
  _verifyMessageSender(originalMessage, sender) {
    if (!originalMessage || !sender) return false;

    const originalSender = originalMessage.sender;

    // Convert both to Buffer if needed
    const originalSenderBuffer = Buffer.isBuffer(originalSender) ?
      originalSender :
      Buffer.from(originalSender, 'hex');

    const senderBuffer = Buffer.isBuffer(sender) ?
      sender :
      Buffer.from(sender, 'hex');

    // Compare the buffers
    return originalSenderBuffer.equals(senderBuffer);
  }


  /**
 * Parse message data from the serialized Hyperdispatch format
 * @private
 * @param {Buffer|Object} data - The serialized message data
 * @returns {Object} - The parsed message object
 */
  _parseMessageData(node) {
    try {
      // If data is already an object (not a Buffer), return it
      if (node && typeof node === 'object' && !Buffer.isBuffer(node.value)) {
        return node.value;
      }

      // If we have a node with value Buffer, use the Hyperdispatch approach
      if (node && node.value && Buffer.isBuffer(node.value)) {
        // Create state object for binary decoding
        const state = { buffer: node.value, start: 1, end: node.value.byteLength };
        // Get message type from first byte
        const messageType = node.value[0];

        // Check if this is a known message type
        if (messageType === 20 || messageType == 21) { // add-message command
          // Use the appropriate encoding based on your schema
          const messageEncoding = this._getMessageEncoding();

          // Decode the message
          const message = messageEncoding.decode(state);
          console.log({ decoded: message })

          // Handle attachments if present
          if (message.hasAttachments && message.attachments) {
            try {
              message.attachments = JSON.parse(message.attachments);
            } catch (err) {
              message.attachments = [];
            }
          }

          return message;
        } else {
          console.warn(`Unknown message type: ${messageType}`);
          return null;
        }
      }

      // If we get here, we don't know how to handle this format
      console.warn('Unknown message data format:', typeof node);
      return null;
    } catch (error) {
      console.error('Error in message parsing:', error);
      return null;
    }
  }

  _getMessageEncoding() {
    const messageEncoding = getEncoding('@roombase/messages');
    return { decode: messageEncoding.decode }
  }

}

function noop(err) {
  if (err) console.error('Operation error:', err)
}

module.exports = GigaRoom
