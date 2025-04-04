// test/message-auth.test.js
const Corestore = require('corestore');
const Gigauser = require('../lib/gigauser/Gigauser.js');
const fs = require('fs');
const path = require('path');
const { rimraf } = require('rimraf');
const crypto = require('crypto');

// Test directories
const TEST_BASE_DIR = path.join('./test-message-auth/');
const TEST_DIR_1 = path.join(TEST_BASE_DIR, 'user-sender');
const TEST_DIR_2 = path.join(TEST_BASE_DIR, 'user-receiver');

// Test seed phrases
const TEST_SEED_1 = 'river blue mountain green forest tall river blue mountain green forest tall';
const TEST_SEED_2 = 'mountain green forest tall river blue mountain green forest tall river';

// Room test data
const TEST_ROOM = {
  name: 'Message Auth Test Room',
  description: 'A room for testing message authentication'
};

// Utility function to create Promise-based event listeners
function waitForEvent(emitter, eventName, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(eventName, handler);
      reject(new Error(`Timeout waiting for ${eventName} event`));
    }, timeout);

    function handler(data) {
      clearTimeout(timer);
      emitter.removeListener(eventName, handler);
      resolve(data);
    }

    console.log('Waiting event for , ', eventName)
    emitter.on(eventName, handler);
  });
}

// Utility function to wait for messages to sync
async function waitForMessageSync(room, channelId, messageId, timeout = 15000) {
  console.log(`Waiting for message ${messageId} to sync...`);

  // First check if message already exists
  try {
    const message = await room.getMessage(messageId);
    if (message) {
      console.log(`Message already synced: ${messageId}`);
      return message;
    }
  } catch (err) {
    console.log(err)
    // Ignore errors, message might not exist yet
  }

  // Otherwise, wait for message update
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      room.removeListener('messages:updated', checkMessages);
      reject(new Error(`Timeout waiting for message ${messageId} to sync`));
    }, timeout);

    async function checkMessages() {
      try {
        const message = await room.getMessage(messageId);
        if (message) {
          clearTimeout(timer);
          room.removeListener('messages:updated', checkMessages);
          console.log(`Message synced: ${messageId}`);
          resolve(message);
        }
      } catch (err) {
        // Message not found yet, keep waiting
      }
    }

    room.on('messages:updated', checkMessages);
  });
}

// Test runner
async function runMessageAuthTest() {
  console.log('🔍 Starting Message Authentication Test...');
  console.log('-----------------------------');

  // Clean up any existing test directories
  await cleanup();

  try {
    // PART 1: Initial Setup and Room Creation
    console.log('\n📋 PHASE 1: Initial Setup');

    // Create corestores for two users
    const store1 = new Corestore(TEST_DIR_1);
    const store2 = new Corestore(TEST_DIR_2);

    await store1.ready();
    await store2.ready();

    // Create first user (sender)
    console.log('  - Creating sender user...');
    const senderUser = await Gigauser.create(store1, TEST_SEED_1);
    await senderUser.ready();
    console.log(`  - Sender user created: ${senderUser.publicKey.toString('hex').substring(0, 8)}...`);

    // Create sender's profile
    await senderUser.updateProfile({
      name: 'Message Sender',
      status: 'Testing message authentication'
    });

    // Create room
    console.log('  - Creating test room...');
    const senderRoom = await senderUser.createRoom(TEST_ROOM);
    console.log(`  - Room created with ID: ${senderRoom.id}`);

    // Create a channel
    console.log('  - Creating a test channel...');
    const channelId = await senderRoom.createChannel({
      name: 'general',
      type: 'text',
      isDefault: true
    });
    console.log(`  - Channel created with ID: ${channelId}`);

    // Create pairing invite
    console.log('  - Generating room invite...');
    const roomInvite = await senderRoom.createInvite();
    console.log(`  - Room invite generated: ${roomInvite.substring(0, 10)}...`);

    // Create second user (receiver)
    console.log('  - Creating receiver user...');
    const receiverUser = await Gigauser.create(store2, TEST_SEED_2);
    await receiverUser.ready();
    console.log(`  - Receiver user created: ${receiverUser.publicKey.toString('hex').substring(0, 8)}...`);

    // Join the room
    console.log('  - Joining the room...');
    const receiverRoom = await receiverUser.joinRoom(roomInvite);
    console.log(`  - Joined room successfully: ${receiverRoom.id}`);

    // Wait for a moment to ensure both rooms are fully initialized
    await new Promise(resolve => setTimeout(resolve, 2000));

    // PART 2: Send and Receive Messages
    console.log('\n📋 PHASE 2: Message Authentication Testing');

    // Send a message from sender
    console.log('  - Sending a normal message...');
    const messageContent = 'Hello! This is a test message with proper authentication.';
    const messageId = await senderRoom.sendMessage(channelId, messageContent);
    console.log(`  - Message sent with ID: ${messageId}`);

    // Wait for message to sync to receiver
    console.log('  - Waiting for message to sync to receiver...');
    const syncedMessage = await waitForMessageSync(receiverRoom, channelId, messageId);
    console.log('  - Message successfully synced to receiver');

    // Verify message content and authentication
    console.log('  - Verifying message content and authentication...');
    if (syncedMessage.content !== messageContent) {
      throw new Error(`Message content doesn't match: ${syncedMessage.content} vs ${messageContent}`);
    }

    const isValid = receiverRoom._verifyMessageSignature(syncedMessage);
    if (!isValid) {
      throw new Error('Message signature verification failed');
    }
    console.log('  - ✅ Message content and signature successfully verified');

    // PART 3: Tamper Detection Testing
    console.log('\n📋 PHASE 3: Message Tampering Detection');

    // Create a tampered message (directly manipulate for testing)
    console.log('  - Creating a tampered message...');
    const tamperedContent = 'This is a TAMPERED message!';

    // Clone the original message and tamper with it
    const tamperedMessage = {
      ...syncedMessage,
      content: tamperedContent,
      id: crypto.randomBytes(8).toString('hex') // New ID
    };

    // Try to verify the tampered message (it should fail)
    console.log('  - Verifying tampered message signature...');
    const isTamperedValid = receiverRoom._verifyMessageSignature(tamperedMessage);

    if (isTamperedValid) {
      throw new Error('Tampered message signature verification unexpectedly passed');
    }
    console.log('  - ✅ Tampered message correctly rejected');

    // PART 4: Message Editing with Authentication
    console.log('\n📋 PHASE 4: Message Editing Authentication');

    // Edit the original message
    console.log('  - Editing the original message...');
    const editedContent = 'This message has been edited with proper authentication.';

    const editMessageEvent = waitForEvent(receiverRoom, "message:edited")
    await senderRoom.editMessage(messageId, editedContent);
    console.log('  - Message edited');

    await editMessageEvent
    // Wait for edit to sync to receiver
    console.log('  - Waiting for edited message to sync...');
    const syncedEditedMessage = await waitForMessageSync(receiverRoom, channelId, messageId);

    // Verify edited message
    console.log('  - Verifying edited message content and authentication...');
    console.log(syncedEditedMessage)
    if (syncedEditedMessage.content !== editedContent) {
      throw new Error(`Edited message content doesn't match: ${syncedEditedMessage.content} vs ${editedContent}`);
    }

    const isEditedValid = receiverRoom._verifyMessageSignature(syncedEditedMessage);
    if (!isEditedValid) {
      throw new Error('Edited message signature verification failed');
    }
    console.log('  - ✅ Edited message content and signature successfully verified');

    // PART 5: Spoofing Attempt (sending as someone else)
    console.log('\n📋 PHASE 5: Identity Spoofing Detection');

    // Attempt to create a spoofed message (this would be rejected by the apply function)
    console.log('  - Testing spoofed message detection...');
    const spoofedContent = 'This message pretends to be from someone else';

    // Create a fake message with wrong sender
    const spoofedMessage = {
      id: crypto.randomBytes(8).toString('hex'),
      roomId: senderRoom.id,
      channelId: channelId,
      type: 'text',
      content: spoofedContent,
      timestamp: Date.now(),

      // SPOOF: Set sender to receiver's key but sign with sender's key
      sender: receiverUser.publicKey,
      senderName: receiverUser.profile.name
    };

    // Sign with sender's key (this would be invalid since sender field is receiver's key)
    spoofedMessage.signature = senderRoom._signMessage(spoofedMessage);

    // Verify the spoofed message (it should fail)
    const isSpoofedValid = receiverRoom._verifyMessageSignature(spoofedMessage);

    if (isSpoofedValid) {
      throw new Error('Spoofed message signature verification unexpectedly passed');
    }
    console.log('  - ✅ Spoofed message correctly rejected');

    console.log('\n-----------------------------');
    console.log('✅ Message Authentication Test Completed Successfully!');

    // Clean up resources
    await senderUser.close();
    await receiverUser.close();
    await store1.close();
    await store2.close();

  } catch (error) {
    console.error('❌ Test failed:', error);
    console.error('Error stack:', error.stack);
    process.exit(1);
  } finally {
    // Clean up test directories
    await cleanup();
  }
}

// Helper function to clean up test directories
async function cleanup() {
  try {
    // Check if directories exist before attempting to remove
    if (fs.existsSync(TEST_DIR_1)) {
      await rimraf(TEST_DIR_1);
    }
    if (fs.existsSync(TEST_DIR_2)) {
      await rimraf(TEST_DIR_2);
    }
    if (fs.existsSync(TEST_BASE_DIR)) {
      await rimraf(TEST_BASE_DIR);
    }
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
}

// Run the tests
runMessageAuthTest().catch(error => {
  console.error('Error running tests:', error);
  process.exit(1);
});
