const Corestore = require('corestore')
const Gigauser = require('../lib/gigauser/Gigauser.js')
const fs = require('fs')
const path = require('path')
const { rimraf } = require('rimraf')

// Test directories
const TEST_BASE_DIR = path.join('./test-gigachat-full/')
const TEST_DIR_1 = path.join(TEST_BASE_DIR, 'user1')
const TEST_DIR_2 = path.join(TEST_BASE_DIR, 'user2')
const TEST_DIR_3 = path.join(TEST_BASE_DIR, 'user3')

// Test seed phrases
const TEST_SEED_1 = 'apple banana cherry dog elephant forest green hotel island jungle king lemon mountain night ocean purple queen river sun tree umbrella violet'
const TEST_SEED_2 = 'beach coconut dragon eagle fire garden honey igloo jungle koala lion mango nest orange penguin queen rabbit snake tiger unicorn volcano wolf'

// Room test data
const TEST_ROOM = {
  name: 'GigaChat Test Room',
  description: 'A room for comprehensive testing',
  type: 'community'
}

// Channel test data
const TEST_CHANNELS = [
  { name: 'general', type: 'text', isDefault: true },
  { name: 'random', type: 'text', isDefault: false }
]

// Utility function for predictable waiting
async function waitWithRetry(checkFn, options = {}) {
  const {
    timeout = 15000,
    interval = 500,
    maxAttempts = 30,
    label = 'condition'
  } = options;

  const startTime = Date.now();
  let attempts = 0;

  while (attempts < maxAttempts && (Date.now() - startTime) < timeout) {
    attempts++;
    try {
      if (await checkFn()) {
        console.log(`✅ ${label} met after ${attempts} attempts (${Date.now() - startTime}ms)`);
        return true;
      }
    } catch (err) {
      // Ignore errors in check function
    }

    if (attempts % 5 === 0) {
      console.log(`Still waiting for ${label}... (attempt ${attempts})`);
    }

    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error(`Timeout waiting for ${label} after ${attempts} attempts (${Date.now() - startTime}ms)`);
}

// Helper function to clean up test directories
async function cleanup() {
  try {
    if (fs.existsSync(TEST_BASE_DIR)) await rimraf(TEST_BASE_DIR);
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
}

// Test runner
async function runTest() {
  console.log('\n===========================');
  console.log('🧪 GIGACHAT SIMPLIFIED TEST');
  console.log('===========================\n');

  // Clean up any existing test directories
  await cleanup();

  try {
    // Create corestores
    const store1 = new Corestore(TEST_DIR_1);
    const store2 = new Corestore(TEST_DIR_2);

    await Promise.all([store1.ready(), store2.ready()]);

    // TEST 1: Create first user
    console.log('Step 1: Creating first user...');
    const user1 = await Gigauser.create(store1, TEST_SEED_1);
    await user1.ready();

    // Verify user1 has a public key
    if (!user1.publicKey) {
      throw new Error('User1 public key not set');
    }
    console.log(`✅ User1 created: ${user1.publicKey.toString('hex').substring(0, 8)}...`);

    // TEST 2: Update profile without waiting for event
    console.log('Step 2: Updating user profile...');
    const testProfile = {
      name: 'TestUser1',
      status: 'Online for Testing',
      avatar: 'test-avatar.png'
    };

    await user1.updateProfile(testProfile);

    // Manually verify profile was updated by checking profile directly
    await waitWithRetry(
      async () => {
        await user1._refreshProfile(); // Force profile refresh
        return user1.profile &&
          user1.profile.name === testProfile.name &&
          user1.profile.status === testProfile.status;
      },
      { label: 'profile update' }
    );

    console.log('✅ Profile updated successfully:', user1.profile.name);

    // TEST 3: Create a room
    console.log('Step 3: Creating a room...');
    const createdRoom = await user1.createRoom(TEST_ROOM);

    if (!createdRoom || !createdRoom.id) {
      throw new Error('Room not created properly');
    }
    console.log(`✅ Room created with ID: ${createdRoom.id}`);

    // Verify room appears in user's room list
    await waitWithRetry(
      async () => {
        await user1._refreshRooms(); // Force room refresh
        return user1.rooms &&
          user1.rooms.length > 0 &&
          user1.rooms.some(r => r.id === createdRoom.id);
      },
      { label: 'room in user list' }
    );

    console.log('✅ Room appears in user room list');

    // TEST 4: Create a channel
    console.log('Step 4: Creating a channel...');
    const channelId = await createdRoom.createChannel(TEST_CHANNELS[0], user1.publicKey);

    if (!channelId) {
      throw new Error('Channel not created properly');
    }
    console.log(`✅ Channel created with ID: ${channelId}`);

    // Verify channel appears in room
    await waitWithRetry(
      async () => {
        await createdRoom._refreshChannels(); // Force channel refresh
        return createdRoom.channels &&
          createdRoom.channels.length > 0 &&
          createdRoom.channels.some(c => c.id === channelId);
      },
      { label: 'channel in room' }
    );

    console.log('✅ Channel appears in room channel list');

    // TEST 5: Create room invite
    console.log('Step 5: Creating room invite...');
    const roomInvite = await createdRoom.createInvite();

    if (!roomInvite) {
      throw new Error('Room invite not created properly');
    }
    console.log(`✅ Room invite created: ${roomInvite.substring(0, 10)}...`);

    // TEST 6: Create second user
    console.log('Step 6: Creating second user...');
    const user2 = await Gigauser.create(store2, TEST_SEED_2);
    await user2.ready();

    if (!user2.publicKey) {
      throw new Error('User2 public key not set');
    }
    console.log(`✅ User2 created: ${user2.publicKey.toString('hex').substring(0, 8)}...`);

    // TEST 7: Join room with second user
    console.log('Step 7: User2 joining room...');
    const joinedRoom = await user2.joinRoom(roomInvite);

    if (!joinedRoom || !joinedRoom.id) {
      throw new Error('Room not joined properly');
    }
    console.log(`✅ User2 joined room with ID: ${joinedRoom.id}`);

    // Verify room appears in user2's room list
    await waitWithRetry(
      async () => {
        await user2._refreshRooms(); // Force room refresh
        return user2.rooms &&
          user2.rooms.length > 0 &&
          user2.rooms.some(r => r.id === joinedRoom.id);
      },
      { label: 'joined room in user2 list' }
    );

    console.log('✅ Joined room appears in user2 room list');

    // TEST 8: Verify channel synchronization
    console.log('Step 8: Verifying channel synchronization...');

    await waitWithRetry(
      async () => {
        await joinedRoom._refreshChannels(); // Force channel refresh
        return joinedRoom.channels &&
          joinedRoom.channels.length > 0 &&
          joinedRoom.channels.some(c => c.name === TEST_CHANNELS[0].name);
      },
      { label: 'channel sync to user2', timeout: 20000 }
    );

    console.log('✅ Channel synchronized to user2');

    // TEST 9: Create a second channel from user2
    console.log('Step 9: User2 creating a second channel...');
    const channel2Id = await joinedRoom.createChannel(TEST_CHANNELS[1], user2.publicKey);

    if (!channel2Id) {
      throw new Error('Second channel not created properly');
    }
    console.log(`✅ Second channel created with ID: ${channel2Id}`);

    // TEST 10: Verify second channel appears in both users' rooms
    console.log('Step 10: Verifying second channel synced to user1...');

    // For user2
    await waitWithRetry(
      async () => {
        await joinedRoom._refreshChannels(); // Force channel refresh
        return joinedRoom.channels &&
          joinedRoom.channels.length >= 2 &&
          joinedRoom.channels.some(c => c.id === channel2Id);
      },
      { label: 'second channel in user2 room' }
    );

    // For user1
    await waitWithRetry(
      async () => {
        await createdRoom._refreshChannels(); // Force channel refresh
        return createdRoom.channels &&
          createdRoom.channels.length >= 2 &&
          createdRoom.channels.some(c => c.name === TEST_CHANNELS[1].name);
      },
      { label: 'second channel sync to user1', timeout: 20000 }
    );

    console.log('✅ Second channel synchronized between users');

    // Print final channel lists for both users
    await createdRoom._refreshChannels();
    await joinedRoom._refreshChannels();

    console.log('\nFinal channel list for User1:');
    createdRoom.channels.forEach(c => {
      console.log(`- ${c.name} (${c.id})`);
    });

    console.log('\nFinal channel list for User2:');
    joinedRoom.channels.forEach(c => {
      console.log(`- ${c.name} (${c.id})`);
    });

    // Verify channel counts match
    if (createdRoom.channels.length !== joinedRoom.channels.length) {
      console.warn(`⚠️ Channel count mismatch: User1 has ${createdRoom.channels.length}, User2 has ${joinedRoom.channels.length}`);
    } else {
      console.log(`✅ Channel counts match: Both users have ${createdRoom.channels.length} channels`);
    }

    // Test COMPLETE
    console.log('\n===========================');
    console.log('✅ GIGACHAT TEST COMPLETED SUCCESSFULLY!');
    console.log('===========================\n');

    // Clean up
    await user1.close();
    await user2.close();
    await store1.close();
    await store2.close();

  } catch (error) {
    console.error('\n❌ TEST FAILED:');
    console.error(error);
    console.error('Error stack:');
    console.error(error.stack);
    process.exit(1);
  } finally {
    // Clean up test directories
    await cleanup();
  }
}

// Run the test
runTest().catch(error => {
  console.error('Error running test:', error);
  process.exit(1);
});
