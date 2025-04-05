// test/device-sync-message-edit.test.js
const Corestore = require('corestore')
const Gigauser = require('../lib/gigauser/Gigauser.js')
const fs = require('fs')
const path = require('path')
const { rimraf } = require('rimraf')
const { promisify } = require('util')

// Test directories
const TEST_BASE_DIR = path.join('./test-device-sync/')
const DEVICE1_DIR = path.join(TEST_BASE_DIR, 'device1')
const DEVICE2_DIR = path.join(TEST_BASE_DIR, 'device2')

// Test seed phrases (unique for this test)
const TEST_SEED = 'green forest blue river mountain tall stone valley deep sky wave'

// Helper function for delay
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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

// Utility function to wait for synchronization with retries
async function waitForSync(condition, maxAttempts = 10, interval = 1000) {
  console.log('Waiting for synchronization...')

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await condition()) {
      console.log(`Synchronized after ${attempt} attempts`)
      return true
    }
    console.log(`Sync attempt ${attempt}/${maxAttempts} failed, retrying...`)
    await new Promise(resolve => setTimeout(resolve, interval))
  }

  throw new Error(`Failed to synchronize after ${maxAttempts} attempts`)
}

// Helper function to clean up test directories
async function cleanup() {
  try {
    // Check if directories exist before attempting to remove
    if (fs.existsSync(DEVICE1_DIR)) {
      await rimraf(DEVICE1_DIR)
    }
    if (fs.existsSync(DEVICE2_DIR)) {
      await rimraf(DEVICE2_DIR)
    }
    if (fs.existsSync(TEST_BASE_DIR)) {
      await rimraf(TEST_BASE_DIR)
    }
  } catch (error) {
    console.error('Error during cleanup:', error)
  }
}

// Test runner
async function runDeviceSyncTest() {
  console.log('🧪 Starting Device Sync and Message Editing Test...')
  console.log('================================================')

  // Clean up any existing test directories
  await cleanup()

  try {
    // PHASE 1: Create first device and user
    console.log('\n📱 PHASE 1: Create First Device User')

    // Create corestore for device 1
    const store1 = new Corestore(DEVICE1_DIR)
    await store1.ready()

    // Create user on device 1
    console.log('  - Creating user on device 1...')
    const device1User = await Gigauser.create(store1, TEST_SEED)
    await device1User.ready()
    console.log(`  - Device 1 user created: ${device1User.publicKey.toString('hex').substring(0, 8)}...`)

    // Create user's profile
    await device1User.updateProfile({
      name: 'Device 1 User',
      status: 'Testing device sync'
    })
    console.log('  - Device 1 user profile created')

    // Create pairing invite for device 2
    console.log('  - Generating device pairing invite...')
    const deviceInvite = await device1User.createPairingInvite()
    console.log(`  - Device pairing invite generated: ${deviceInvite.substring(0, 10)}...`)

    // PHASE 2: Set up second device and sync
    console.log('\n📱 PHASE 2: Set Up Second Device and Sync')

    // Create corestore for device 2
    const store2 = new Corestore(DEVICE2_DIR)
    await store2.ready()

    // Pair device 2 with invite from device 1
    console.log('  - Pairing device 2 with invite...')
    const device2User = await Gigauser.pairDevice(store2, deviceInvite)
    await device2User.ready()
    await delay(2000)
    console.log(`  - Device 2 user paired: ${device2User.publicKey.toString('hex').substring(0, 8)}...`)

    // Verify both devices have the same identity
    console.log('  - Verifying device identity...')
    if (device1User.publicKey.toString('hex') !== device2User.publicKey.toString('hex')) {
      throw new Error('Device identity mismatch after pairing')
    }
    console.log('  - Devices successfully paired with same identity')

    // PHASE 3: Create room on device 1
    console.log('\n📱 PHASE 3: Create Room on Device 1')

    // Create room
    console.log('  - Creating test room on device 1...')
    const roomData = {
      name: 'Device Sync Test Room',
      description: 'A room for testing device synchronization and message editing',
      type: 'community'
    }

    const device1Room = await device1User.createRoom(roomData)
    console.log(`  - Room created on device 1 with ID: ${device1Room.id}`)

    // Wait for room list to update
    await device1User.refreshRooms()
    console.log(`  - Device 1 has ${device1User.rooms.length} rooms`)

    // PHASE 4: Verify room syncs to device 2
    console.log('\n📱 PHASE 4: Verify Room Syncs to Device 2')

    // Wait for room to sync to device 2
    console.log('  - Waiting for room to sync to device 2...')
    await waitForSync(async () => {
      await device2User.refreshRooms()
      return device2User.rooms.length > 0 && device2User.rooms[0].id === device1Room.id
    })

    console.log(`  - Device 2 has ${device2User.rooms.length} rooms`)
    console.log(`  - Device 2 room ID: ${device2User.rooms[0].id}`)

    // Get room instance on device 2
    const device2Room = await device2User.getRoom(device2User.rooms[0].id)
    console.log('  - Successfully accessed room on device 2')

    // PHASE 5: Create channel on device 1
    console.log('\n📱 PHASE 5: Create Channel on Device 1')

    // Create channel on device 1
    console.log('  - Creating channel on device 1...')
    const channelId = await device1Room.createChannel({
      name: 'general',
      type: 'text'
    })
    console.log(`  - Channel created on device 1 with ID: ${channelId}`)

    // Wait for channel to be created on device 1
    await device1Room._refreshChannels()
    console.log(`  - Device 1 has ${device1Room.channels.length} channels`)

    // PHASE 6: Verify channel syncs to device 2
    console.log('\n📱 PHASE 6: Verify Channel Syncs to Device 2')

    // Wait for channel to sync to device 2
    console.log('  - Waiting for channel to sync to device 2...')
    await waitForSync(async () => {
      await device2Room._refreshChannels()
      return device2Room.channels.length > 0
    })

    console.log(`  - Device 2 has ${device2Room.channels.length} channels`)
    console.log(`  - Device 2 channel ID: ${device2Room.channels[0].id}`)

    // Verify channel IDs match
    if (device1Room.channels[0].id !== device2Room.channels[0].id) {
      throw new Error('Channel ID mismatch after sync')
    }
    console.log('  - Channel successfully synced between devices')

    // PHASE 7: Send message from device 1
    console.log('\n📱 PHASE 7: Send Message from Device 1')

    // Send a message from device 1
    console.log('  - Sending message from device 1...')
    const messageContent = 'Hello from device 1! This is a test message for editing.'
    const messageId = await device1Room.sendMessage(channelId, messageContent)
    console.log(`  - Message sent from device 1 with ID: ${messageId}`)

    // PHASE 8: Verify message syncs to device 2 and edit it
    console.log('\n📱 PHASE 8: Verify Message Syncs to Device 2 and Edit It')

    // Wait for the message to sync
    console.log('  - Waiting for message to sync to device 2...')
    await waitForSync(async () => {
      const messages = await device2Room.getMessages(channelId)
      return messages.length > 0 && messages[0].id === messageId
    })

    // Get and verify the message on device 2
    const syncedMessage = await device2Room.getMessage(messageId)
    console.log('  - Message successfully synced to device 2')
    // console.log(`  - Original message content: "${syncedMessage.content}"`)

    console.log('Waiting for writable event')
    // await waitForEvent(device2Room, 'writable')
    // Edit the message from device 2
    console.log('  - Editing message from device 2...')
    const editedContent = 'This message was edited by device 2!'
    await device2Room.editMessage(messageId, editedContent)
    console.log('  - Message edited from device 2')

    // PHASE 9: Verify edited message syncs back to device 1
    console.log('\n📱 PHASE 9: Verify Edited Message Syncs Back to Device 1')

    // Wait for edit to sync back to device 1
    console.log('  - Waiting for edited message to sync back to device 1...')
    await waitForSync(async () => {
      const message = await device1Room.getMessage(messageId)
      return message && message.content === editedContent && message.edited === true
    })

    // Get and verify the edited message on device 1
    const editedMessage = await device1Room.getMessage(messageId)
    console.log('  - Edited message successfully synced back to device 1')
    // console.log(`  - Edited message content: "${editedMessage.content}"`)
    // console.log(`  - Message edited flag: ${editedMessage.edited}`)

    if (editedMessage.content !== editedContent) {
      throw new Error('Edited message content mismatch')
    }
    if (!editedMessage.edited) {
      throw new Error('Edited flag not set to true')
    }

    console.log('================================================')
    console.log('✅ Device Sync and Message Editing Test Completed Successfully!')

    // Clean up
    await device1User.close()
    await device2User.close()
    await store1.close()
    await store2.close()

  } catch (error) {
    console.error('❌ Test failed:', error)
    console.error('Error stack:', error.stack)
    process.exit(1)
  } finally {
    // Clean up test directories
    await cleanup()
  }
}

// Run the test
runDeviceSyncTest().catch(error => {
  console.error('Error running test:', error)
  process.exit(1)
})
