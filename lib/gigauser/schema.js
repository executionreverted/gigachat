// gigauser-schema.js - Schema definition for Gigauser module

const Hyperschema = require('hyperschema')
const HyperdbBuilder = require('hyperdb/builder')
const Hyperdispatch = require('hyperdispatch')

// Create schema namespace
const gigauser = Hyperschema.from('./spec/schema')
const template = gigauser.namespace('gigauser')

// Base schemas for writer management (similar to Autopass)
template.register({
  name: 'writer',
  compact: false,
  fields: [{
    name: 'key',
    type: 'buffer',
    required: true
  }]
})

template.register({
  name: 'invite',
  compact: false,
  fields: [{
    name: 'id',
    type: 'buffer',
    required: true
  }, {
    name: 'invite',
    type: 'buffer',
    required: true
  }, {
    name: 'publicKey',
    type: 'buffer',
    required: true
  }, {
    name: 'expires',
    type: 'int',
    required: true
  }]
})

// User profile schema
template.register({
  name: 'profile',
  compact: false,
  fields: [{
    name: 'key',
    type: 'string',
    required: true
  }, {
    name: 'value',
    type: 'string',
    required: true
  }]
})

// User rooms list schema
template.register({
  name: 'rooms',
  compact: false,
  fields: [{
    name: 'key',
    type: 'string',
    required: true
  }, {
    name: 'value',
    type: 'string',
    required: true
  }]
})

// User devices schema
template.register({
  name: 'devices',
  compact: false,
  fields: [{
    name: 'key',
    type: 'string',
    required: true
  }, {
    name: 'value',
    type: 'string',
    required: true
  }]
})

// User settings schema
template.register({
  name: 'settings',
  compact: false,
  fields: [{
    name: 'key',
    type: 'string',
    required: true
  }, {
    name: 'value',
    type: 'string',
    required: true
  }]
})

template.register({
  name: 'identity',
  compact: false,
  fields: [{
    name: 'key',
    type: 'string',
    required: true
  }, {
    name: 'value',
    type: 'string',
    required: true
  }]
})

// Write schemas to disk
Hyperschema.toDisk(gigauser)

// Create database template
const dbTemplate = HyperdbBuilder.from('./spec/schema', './spec/db')
const collections = dbTemplate.namespace('gigauser')

// Register collections for database
collections.collections.register({
  name: 'writer',
  schema: '@gigauser/writer',
  key: ['key']
})

collections.collections.register({
  name: 'invite',
  schema: '@gigauser/invite',
  key: ['id']
})

collections.collections.register({
  name: 'profile',
  schema: '@gigauser/profile',
  key: ['key']
})

collections.collections.register({
  name: 'rooms',
  schema: '@gigauser/rooms',
  key: ['key']
})

collections.collections.register({
  name: 'devices',
  schema: '@gigauser/devices',
  key: ['key']
})

collections.collections.register({
  name: 'settings',
  schema: '@gigauser/settings',
  key: ['key']
})

collections.collections.register({
  name: 'identity',
  schema: '@gigauser/identity',
  key: ['key']
})

// Write database template to disk
HyperdbBuilder.toDisk(dbTemplate)

// Setup command dispatching
const hyperdispatch = Hyperdispatch.from('./spec/schema', './spec/hyperdispatch')
const namespace = hyperdispatch.namespace('gigauser')

// Register command handlers
namespace.register({
  name: 'remove-writer',
  requestType: '@gigauser/writer'
})

namespace.register({
  name: 'add-writer',
  requestType: '@gigauser/writer'
})

namespace.register({
  name: 'add-invite',
  requestType: '@gigauser/invite'
})

namespace.register({
  name: 'set-profile',
  requestType: '@gigauser/profile'
})

namespace.register({
  name: 'update-rooms',
  requestType: '@gigauser/rooms'
})

namespace.register({
  name: 'update-devices',
  requestType: '@gigauser/devices'
})

namespace.register({
  name: 'update-settings',
  requestType: '@gigauser/settings'
})

namespace.register({
  name: 'set-identity',
  requestType: '@gigauser/identity'
})

// Write dispatch configuration to disk
Hyperdispatch.toDisk(hyperdispatch)

module.exports = { gigauser, dbTemplate, hyperdispatch }
