// test/device-sync.test.js
const Corestore = require('corestore')
const Gigauser = require('../lib/gigauser/Gigauser.js')
const fs = require('fs')
const path = require('path')
const { rimraf } = require('rimraf')

// Test directories
const TEST_BASE_DIR = path.join('./test-device-sync/')
const TEST_DIR_1 = path.join(TEST_BASE_DIR, 'user-device1')
const TEST_DIR_2 = path.join(TEST_BASE_DIR, 'user-device2')

// Test seed phrase (same seed used for both devices)
const TEST_SEED = 'river blue mountain green forest tall river blue mountain green forest tall'

// Test room data
const TEST_ROOM_1 = {
  name: 'Room Created on Device 1',
  description: 'A room for testing device synchronization - from Device 1',
  type: 'community'
}

const TEST_ROOM_2 = {
  name: 'Room Created on Device 2',
  description: 'A room for testing device synchronization - from Device 2',
  type: 'community'
}

// Utility delay function
function delay(ms, message = '') {
  console.log(`⏳ Waiting ${ms}ms: ${message}`)
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Room logging function
function logRooms(title, rooms) {
  console.log(`\n${title} Rooms:`)
  if (!rooms || rooms.length === 0) {
    console.log('  No rooms found')
    return
  }
  rooms.forEach((room, index) => {
    console.log(`  ${index + 1}. ID: ${room.id}, Name: ${room.name}`)
  })
}

// Channels logging function
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

// Test runner
async function runDeviceSyncTest() {
  console.log('🔍 Starting Device Synchronization Test...')
  console.log('-----------------------------')

  // Clean up any existing test directories
  await cleanup()

  try {
    // PHASE 1: Initial Setup and Device Pairing
    console.log('\n📋 PHASE 1: Initial Setup and Device Pairing')

    // Create corestores for both devices
    const store1 = new Corestore(TEST_DIR_1)
    const store2 = new Corestore(TEST_DIR_2)

    await store1.ready()
    await store2.ready()

    // Create first device user
    console.log('  - Creating user on Device 1...')
    const device1User = await Gigauser.create(store1, TEST_SEED)
    await device1User.ready()
    console.log(`  - Device 1 user created: ${device1User.publicKey.toString('hex').substring(0, 8)}...`)

    // Create Device 1 profile
    await device1User.updateProfile({
      name: 'Test User',
      status: 'Testing Device Sync'
    })

    // Generate device pairing invite
    console.log('  - Generating device pairing invite...')
    const deviceInvite = await device1User.createPairingInvite()
    console.log(`  - Device pairing invite generated: ${deviceInvite.substring(0, 10)}...`)

    // Wait for network setup
    await delay(2000, 'Initial network setup')

    // Pair second device
    console.log('  - Pairing Device 2...')
    const device2User = await Gigauser.pairDevice(store2, deviceInvite)
    await device2User.ready()
    await delay(3000)
    console.log(`  - Device 2 paired successfully: ${device2User?.publicKey?.toString('hex').substring(0, 8)}...`)

    // Wait for pairing to fully propagate
    await delay(3000, 'Device pairing propagation')

    // Verify both devices have the same public key (same user)
    if (!device1User.publicKey.equals(device2User.publicKey)) {
      throw new Error('Device pairing failed: Public keys do not match')
    }
    console.log('  ✅ Device pairing successful: Both devices have the same identity')

    // Verify profile sync
    console.log(`  - Device 1 profile name: ${device1User.profile.name}`)
    console.log(`  - Device 2 profile name: ${device2User.profile.name}`)
    if (device1User.profile.name !== device2User.profile.name) {
      throw new Error('Profile synchronization failed')
    }
    console.log('  ✅ Profile synchronized successfully')

    // PHASE 2: Room Creation on Device 1
    console.log('\n📋 PHASE 2: Room Creation on Device 1')

    // Create room on Device 1
    console.log('  - Creating room on Device 1...')
    const device1Room = await device1User.createRoom(TEST_ROOM_1)
    console.log(`  - Room created on Device 1 with ID: ${device1Room.id}`)

    // Wait for room to sync to Device 2
    await delay(5000, 'Waiting for room to sync to Device 2')

    // Verify room sync
    logRooms('Device 1', device1User.rooms)
    logRooms('Device 2', device2User.rooms)

    if (device1User.rooms.length !== device2User.rooms.length) {
      throw new Error('Room count mismatch after Device 1 room creation')
    }

    const device1RoomId = device1User.rooms[0].id
    const device2HasRoom = device2User.rooms.some(room => room.id === device1RoomId)

    if (!device2HasRoom) {
      throw new Error('Room created on Device 1 was not synced to Device 2')
    }

    console.log('  ✅ Room created on Device 1 successfully synced to Device 2')

    // PHASE 3: Room Creation on Device 2
    console.log('\n📋 PHASE 3: Room Creation on Device 2')

    // Create room on Device 2
    console.log('  - Creating room on Device 2...')
    const device2Room = await device2User.createRoom(TEST_ROOM_2)
    console.log(`  - Room created on Device 2 with ID: ${device2Room.id}`)

    // Wait for room to sync to Device 1
    await delay(5000, 'Waiting for room to sync to Device 1')

    // Verify room sync back to Device 1
    logRooms('Device 1 after Device 2 room creation', device1User.rooms)
    logRooms('Device 2 after Device 2 room creation', device2User.rooms)

    if (device1User.rooms.length !== device2User.rooms.length) {
      throw new Error('Room count mismatch after Device 2 room creation')
    }

    const device2RoomId = device2Room.id
    const device1HasDevice2Room = device1User.rooms.some(room => room.id === device2RoomId)

    if (!device1HasDevice2Room) {
      throw new Error('Room created on Device 2 was not synced to Device 1')
    }
    console.log('  ✅ Room created on Device 2 successfully synced to Device 1')

    // PHASE 4: Close and Reinitialize
    console.log('\n📋 PHASE 4: Close and Reinitialize')

    // Close all instances
    await device1User.close()
    await device2User.close()
    await store1.close()
    await store2.close()

    console.log('  - All instances closed')

    // Wait a bit before reinitialization
    await delay(2000, 'Waiting before reinitialization')

    // Reinitialize stores and users
    const reInitStore1 = new Corestore(TEST_DIR_1)
    const reInitStore2 = new Corestore(TEST_DIR_2)

    await reInitStore1.ready()
    await reInitStore2.ready()

    console.log('  - Reinitializing Device 1 user...')
    const reInitDevice1User = await Gigauser.create(reInitStore1, TEST_SEED)
    await reInitDevice1User.ready()

    console.log('  - Reinitializing Device 2 user...')
    const reInitDevice2User = await Gigauser.create(reInitStore2, TEST_SEED)
    await reInitDevice2User.ready()

    console.log('  - Both devices reinitialized')

    // Wait for reinitialization to complete
    await delay(3000, 'Waiting for reinitialization to complete')

    // Verify rooms are still present after reinitialization
    logRooms('Device 1 after reinitialization', reInitDevice1User.rooms)
    logRooms('Device 2 after reinitialization', reInitDevice2User.rooms)

    if (reInitDevice1User.rooms.length !== reInitDevice2User.rooms.length) {
      throw new Error('Room count mismatch after reinitialization')
    }
    console.log('  ✅ Rooms persisted through reinitialization')

    // PHASE 5: Channel Creation After Reinitialization
    console.log('\n📋 PHASE 5: Channel Creation After Reinitialization')

    // Get first room on Device 1
    const reInitDevice1Room = await reInitDevice1User.getRoom(reInitDevice1User.rooms[0].roomNamespace)
    console.log(`  - Retrieved room on Device 1: ${reInitDevice1Room.id}`)

    // Create channel in the room
    console.log('  - Creating channel in the room...')
    const channelId = await reInitDevice1Room.createChannel({
      name: 'test-channel',
      type: 'text',
      isDefault: false
    })
    console.log(`  - Channel created with ID: ${channelId}`)

    // Wait for channel to sync
    await delay(5000, 'Waiting for channel to sync to Device 2')

    // Get devices' rooms to verify channel sync
    const device1RoomAfterChannel = await reInitDevice1User.getRoom(reInitDevice1User.rooms[0].roomNamespace)
    const device2RoomAfterChannel = await reInitDevice2User.getRoom(reInitDevice2User.rooms[0].roomNamespace)

    // Log channels for both devices
    logChannels('Device 1', device1RoomAfterChannel.channels)
    logChannels('Device 2', device2RoomAfterChannel.channels)

    // Verify channel sync
    if (device1RoomAfterChannel.channels.length !== device2RoomAfterChannel.channels.length) {
      throw new Error('Channel count mismatch after channel creation')
    }

    // Check if channel with specific name exists on Device 2
    const device2HasChannel = device2RoomAfterChannel.channels.some(channel => channel.name === 'test-channel')
    if (!device2HasChannel) {
      throw new Error('Channel created on Device 1 was not synced to Device 2')
    }
    console.log('  ✅ Channel created on Device 1 successfully synced to Device 2')

    console.log('-----------------------------')
    console.log('✅ Device Synchronization Test Completed Successfully!')

    // Clean up final resources
    await reInitDevice1User.close()
    await reInitDevice2User.close()
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
runDeviceSyncTest().catch(error => {
  console.error('Error running tests:', error)
  process.exit(1)
})
