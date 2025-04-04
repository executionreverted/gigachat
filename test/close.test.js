// test/channel-sync-event.test.js
const Corestore = require('corestore')
const Gigauser = require('../lib/gigauser/Gigauser.js')
const fs = require('fs')
const path = require('path')
const { rimraf } = require('rimraf')
const { promisify } = require('util')

// Test directories
const TEST_BASE_DIR = path.join('./test-channel-sync/')
const TEST_DIR_1 = path.join(TEST_BASE_DIR, 'user-creator')
const TEST_DIR_2 = path.join(TEST_BASE_DIR, 'user-joiner')

// Test seed phrases (unique for each test)
const TEST_SEED_1 = 'river blue mountain green forest tall river blue mountain green forest tall'
const TEST_SEED_2 = 'mountain green forest tall river blue mountain green forest tall river'

// Room test data
const TEST_ROOM = {
  name: 'Channel Sync Test Room',
  description: 'A room for testing channel synchronization',
  type: 'community'
}

// Utility function to create Promise-based event listeners
function waitForEvent(emitter, eventName, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(eventName, handler)
      reject(new Error(`Timeout waiting for ${eventName} event`))
    }, timeout)

    function handler(data) {
      clearTimeout(timer)
      emitter.removeListener(eventName, handler)
      resolve(data)
    }

    emitter.on(eventName, handler)
  })
}

// Detailed logging function
function logChannels(title, channels) {
  console.log(`\n${title} Channels:`)
  if (!channels || channels.length === 0) {
    console.log('  No channels found')
    return
  }
  channels.forEach((channel, index) => {
    console.log(`  ${index + 1}. ID: ${channel.id}, Name: ${channel.name}, Position: ${channel.position}`)
  })
}

// Utility function to wait for channel updates
async function waitForChannelsUpdate(room, expectedLength, timeout = 15000) {
  console.log(`Waiting for room ${room.id} to have ${expectedLength} channels...`)

  // First check if channels already match expected length
  await room._refreshChannels()
  if (room.channels.length === expectedLength) {
    console.log(`Room already has ${expectedLength} channels.`)
    return room.channels
  }

  // Otherwise, wait for a channels update
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      room.removeListener('channels:updated', handler)
      reject(new Error(`Timeout waiting for channels to update to ${expectedLength} (current: ${room.channels.length})`))
    }, timeout)

    function handler(channels) {
      if (channels.length === expectedLength) {
        clearTimeout(timer)
        room.removeListener('channels:updated', handler)
        console.log(`Room now has ${expectedLength} channels.`)
        resolve(channels)
      } else {
        console.log(`Got channel update but count is ${channels.length}, waiting for ${expectedLength}...`)
      }
    }

    room.on('channels:updated', handler)

    // Force an update to trigger events
    room.forceUpdate().catch(err => {
      console.error('Error forcing update:', err)
    })
  })
}

// Test runner
async function runChannelSyncTest() {
  console.log('🔍 Starting Event-Based Channel Synchronization Test...')
  console.log('-----------------------------')

  // Clean up any existing test directories
  await cleanup()

  try {
    // PART 1: Initial Setup and Room Creation
    console.log('\n📋 PHASE 1: Initial Setup')

    // Create corestores for two users
    const store1 = new Corestore(TEST_DIR_1)
    const store2 = new Corestore(TEST_DIR_2)

    await store1.ready()
    await store2.ready()

    // Create first user (room creator)
    console.log('  - Creating first user...')
    const creatorUser = await Gigauser.create(store1, TEST_SEED_1)
    await creatorUser.ready()
    console.log(`  - Creator user created: ${creatorUser.publicKey.toString('hex').substring(0, 8)}...`)

    // Create first user's profile
    await creatorUser.updateProfile({
      name: 'Room Creator',
      status: 'Creating Sync Test Room'
    })

    // Create room
    console.log('  - Creating test room...')
    const createdRoom = await creatorUser.createRoom(TEST_ROOM)
    console.log(`  - Room created with ID: ${createdRoom.id}`)

    // Create pairing invite
    console.log('  - Generating room invite...')
    const roomInvite = await createdRoom.createInvite()
    console.log(`  - Room invite generated: ${roomInvite.substring(0, 10)}...`)

    // Create second user (room joiner)
    console.log('  - Creating second user...')
    const joinerUser = await Gigauser.create(store2, TEST_SEED_2)
    await joinerUser.ready()
    console.log(`  - Joiner user created: ${joinerUser.publicKey.toString('hex').substring(0, 8)}...`)

    // Join the room and wait for 'update:complete' event
    console.log('  - Joining the room...')
    const joinPromise = joinerUser.joinRoom(roomInvite)

    const joinedRoom = await joinPromise
    console.log(`  - Joined room successfully: ${joinedRoom.id}`)

    console.log({
      creatorRooms: creatorUser.rooms,
      joinerRooms: joinerUser.rooms
    })

    // PART 2: First Channel Creation
    console.log('\n📋 PHASE 2: First Channel Creation')

    // Create first channel by creator
    const creatorRoom = await creatorUser.getRoom(creatorUser.rooms[0].id)
    console.log('Creator room retrieved:', {
      roomId: creatorRoom.id,
      baseReady: !!creatorRoom.base,
      baseKey: creatorRoom.base ? creatorRoom.base.key.toString('hex') : 'No base'
    })

    // Set up event listeners for both rooms
    const creatorChannelUpdatePromise = waitForEvent(creatorRoom, 'channels:updated')

    // Create the channel
    console.log('Creating first channel: general-chat')
    await creatorRoom.createChannel({
      name: 'general-chat',
      type: 'text',
      isDefault: true
    })

    // Wait for creator's channel update
    await creatorChannelUpdatePromise
    console.log('Creator detected channel update')

    // Wait for joiner to get the channel update
    const joinerRoom = await joinerUser.getRoom(joinerUser.rooms[0].id)
    await waitForChannelsUpdate(joinerRoom, 1)

    // Verify channels
    const creatorRoomChannels = await creatorRoom._refreshChannels()
    const joinerRoomChannels = await joinerRoom._refreshChannels()

    logChannels('Creator', creatorRoomChannels)
    logChannels('Joiner', joinerRoomChannels)

    // Verify channel sync
    if (creatorRoom.channels.length !== joinerRoom.channels.length) {
      throw new Error(`Channel count mismatch after first channel creation: creator has ${creatorRoom.channels.length}, joiner has ${joinerRoom.channels.length}`)
    }
    console.log('✅ First channel successfully synchronized')

    // PART 3: Close and Reinitialize
    console.log('\n📋 PHASE 3: Close and Reinitialize')

    // Close all instances
    await creatorUser.close()
    await joinerUser.close()
    await store1.close()
    await store2.close()

    // Reinitialize stores and users
    const reInitStore1 = new Corestore(TEST_DIR_1)
    const reInitStore2 = new Corestore(TEST_DIR_2)

    await reInitStore1.ready()
    await reInitStore2.ready()

    const reInitCreatorUser = new Gigauser(reInitStore1)
    const reInitJoinerUser = new Gigauser(reInitStore2)

    await reInitCreatorUser.ready()
    await reInitJoinerUser.ready()
    console.log('Users successfully reinitialized')

    // PART 4: Second Channel Creation After Reinitialization
    console.log('\n📋 PHASE 4: Second Channel Creation After Reinitialization')

    console.log('ROOMS OF CREATOR AFTER REINIT:', reInitCreatorUser.rooms, Array.from(reInitCreatorUser._roomInstances.entries()))
    console.log('ROOMS OF JOINER AFTER REINIT:', reInitJoinerUser.rooms, Array.from(reInitJoinerUser._roomInstances.entries()))

    // Get rooms for reinitialized users
    const reInitCreatorRoom = await reInitCreatorUser.getRoom(reInitCreatorUser.rooms[0].id)
    const reInitJoinerRoom = await reInitJoinerUser.getRoom(reInitJoinerUser.rooms[0].id)

    console.log('Initiated rooms', reInitCreatorRoom, reInitJoinerUser)
    // Force update to load existing channels
    await reInitCreatorRoom.forceUpdate()
    await reInitJoinerRoom.forceUpdate()

    // Set up event promises
    const creatorSecondChannelUpdatePromise = waitForEvent(reInitCreatorRoom, 'channels:updated')

    // Create second channel
    console.log('Creating second channel: gaming')
    await reInitCreatorRoom.createChannel({
      name: 'gaming',
      type: 'text',
      isDefault: false
    })

    // Wait for creator's update
    await creatorSecondChannelUpdatePromise
    console.log('Creator detected second channel update')

    // Wait for joiner to get the channel update
    await waitForChannelsUpdate(reInitJoinerRoom, 2)

    // Refresh and check final channels
    const finalCreatorChannels = await reInitCreatorRoom._refreshChannels()
    const finalJoinerChannels = await reInitJoinerRoom._refreshChannels()

    logChannels('Final Creator channels', finalCreatorChannels)
    logChannels('Final Joiner channels', finalJoinerChannels)

    // Verify final channel count
    if (finalCreatorChannels.length !== finalJoinerChannels.length) {
      throw new Error(`Final channel count mismatch: creator has ${finalCreatorChannels.length}, joiner has ${finalJoinerChannels.length}`)
    }

    console.log('-----------------------------')
    console.log('✅ Channel Synchronization Test Completed Successfully!')

    // Clean up
    await reInitCreatorUser.close()
    await reInitJoinerUser.close()
    await reInitStore1.close()
    await reInitStore2.close()

  } catch (error) {
    console.error('❌ Test failed:', error)
    console.error('Error stack:', error.stack)
    process.exit(1)
  } finally {
    // Clean up test directories
    await cleanup()
  }
}

// Helper function to clean up test directories
async function cleanup() {
  try {
    // Check if directories exist before attempting to remove
    if (fs.existsSync(TEST_DIR_1)) {
      await rimraf(TEST_DIR_1)
    }
    if (fs.existsSync(TEST_DIR_2)) {
      await rimraf(TEST_DIR_2)
    }
    if (fs.existsSync(TEST_BASE_DIR)) {
      await rimraf(TEST_BASE_DIR)
    }
  } catch (error) {
    console.error('Error during cleanup:', error)
  }
}

// Run the tests
runChannelSyncTest().catch(error => {
  console.error('Error running tests:', error)
  process.exit(1)
})
