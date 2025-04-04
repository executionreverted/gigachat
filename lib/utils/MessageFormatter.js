// lib/utils/MessageFormatter.js
// Utility for parsing, formatting, and rendering messages with rich text, mentions, etc.

class MessageFormatter {
  constructor(opts = {}) {
    this.mentionRegex = /@(\w+)/g;
    this.channelRegex = /#([a-zA-Z0-9-]+)/g;
    this.emojiRegex = /:([a-zA-Z0-9_+-]+):/g;
    this.urlRegex = /https?:\/\/[^\s]+/g;
    this.codeBlockRegex = /```([a-zA-Z]*)\n([\s\S]*?)```/g;
    this.inlineCodeRegex = /`([^`]+)`/g;
    this.boldRegex = /\*\*([^*]+)\*\*/g;
    this.italicRegex = /\*([^*]+)\*/g;
    this.strikethroughRegex = /~~([^~]+)~~/g;

    // Optional callbacks for resolving mentions, etc.
    this.resolveMember = opts.resolveMember || null;
    this.resolveChannel = opts.resolveChannel || null;
    this.resolveEmoji = opts.resolveEmoji || null;
  }

  /**
   * Parse message content to extract mentions, channels, etc.
   * @param {String} content - The raw message content
   * @returns {Object} - Parsed message with extracted entities
   */
  parseMessage(content) {
    if (!content) return { content: '', entities: [] };

    const entities = [];
    let index = 0;

    // Extract mentions
    const mentionMatches = [...content.matchAll(this.mentionRegex)];
    for (const match of mentionMatches) {
      entities.push({
        type: 'mention',
        text: match[0],
        name: match[1],
        indices: [match.index, match.index + match[0].length],
        offset: index
      });
      index++;
    }

    // Extract channels
    const channelMatches = [...content.matchAll(this.channelRegex)];
    for (const match of channelMatches) {
      entities.push({
        type: 'channel',
        text: match[0],
        name: match[1],
        indices: [match.index, match.index + match[0].length],
        offset: index
      });
      index++;
    }

    // Extract emojis
    const emojiMatches = [...content.matchAll(this.emojiRegex)];
    for (const match of emojiMatches) {
      entities.push({
        type: 'emoji',
        text: match[0],
        name: match[1],
        indices: [match.index, match.index + match[0].length],
        offset: index
      });
      index++;
    }

    // Extract URLs
    const urlMatches = [...content.matchAll(this.urlRegex)];
    for (const match of urlMatches) {
      entities.push({
        type: 'url',
        text: match[0],
        url: match[0],
        indices: [match.index, match.index + match[0].length],
        offset: index
      });
      index++;
    }

    // Extract code blocks
    const codeBlockMatches = [...content.matchAll(this.codeBlockRegex)];
    for (const match of codeBlockMatches) {
      entities.push({
        type: 'code_block',
        text: match[0],
        language: match[1] || '',
        code: match[2],
        indices: [match.index, match.index + match[0].length],
        offset: index
      });
      index++;
    }

    // Extract inline code
    const inlineCodeMatches = [...content.matchAll(this.inlineCodeRegex)];
    for (const match of inlineCodeMatches) {
      entities.push({
        type: 'inline_code',
        text: match[0],
        code: match[1],
        indices: [match.index, match.index + match[0].length],
        offset: index
      });
      index++;
    }

    // Extract formatting (bold, italic, strikethrough)
    const boldMatches = [...content.matchAll(this.boldRegex)];
    for (const match of boldMatches) {
      entities.push({
        type: 'bold',
        text: match[0],
        content: match[1],
        indices: [match.index, match.index + match[0].length],
        offset: index
      });
      index++;
    }

    const italicMatches = [...content.matchAll(this.italicRegex)];
    for (const match of italicMatches) {
      entities.push({
        type: 'italic',
        text: match[0],
        content: match[1],
        indices: [match.index, match.index + match[0].length],
        offset: index
      });
      index++;
    }

    const strikethroughMatches = [...content.matchAll(this.strikethroughRegex)];
    for (const match of strikethroughMatches) {
      entities.push({
        type: 'strikethrough',
        text: match[0],
        content: match[1],
        indices: [match.index, match.index + match[0].length],
        offset: index
      });
      index++;
    }

    // Sort entities by their position in the text
    entities.sort((a, b) => a.indices[0] - b.indices[0]);

    return {
      content,
      entities
    };
  }

  /**
   * Extract mentions from a message content
   * @param {String} content - Message content
   * @returns {Array} - Array of mention names
   */
  extractMentions(content) {
    if (!content) return [];

    const mentions = [];
    const matches = content.matchAll(this.mentionRegex);

    for (const match of matches) {
      mentions.push(match[1]); // Just the username without @
    }

    return mentions;
  }

  /**
   * Extract channel references from a message content
   * @param {String} content - Message content
   * @returns {Array} - Array of channel names
   */
  extractChannels(content) {
    if (!content) return [];

    const channels = [];
    const matches = content.matchAll(this.channelRegex);

    for (const match of matches) {
      channels.push(match[1]); // Just the channel name without #
    }

    return channels;
  }

  /**
   * Convert message content to searchable text
   * Removes formatting, replaces mentions with names if available, etc.
   * @param {String} content - Message content
   * @param {Object} opts - Options for resolving mentions, etc.
   * @returns {String} - Plain text for search indexing
   */
  toSearchableText(content, opts = {}) {
    if (!content) return '';

    let searchable = content;

    // Replace code blocks with their content
    searchable = searchable.replace(this.codeBlockRegex, ' $2 ');

    // Replace inline code with its content
    searchable = searchable.replace(this.inlineCodeRegex, ' $1 ');

    // Replace formatting with plain text
    searchable = searchable.replace(this.boldRegex, '$1');
    searchable = searchable.replace(this.italicRegex, '$1');
    searchable = searchable.replace(this.strikethroughRegex, '$1');

    // Replace mentions with names if available
    if (opts.members) {
      searchable = searchable.replace(this.mentionRegex, (match, name) => {
        const member = opts.members.find(m => m.displayName === name);
        return member ? member.displayName : name;
      });
    }

    // Replace channel references with names if available
    if (opts.channels) {
      searchable = searchable.replace(this.channelRegex, (match, name) => {
        const channel = opts.channels.find(c => c.name === name);
        return channel ? channel.name : name;
      });
    }

    // Replace emojis with their names
    searchable = searchable.replace(this.emojiRegex, ' $1 ');

    // Normalize whitespace
    searchable = searchable.replace(/\s+/g, ' ').trim();

    return searchable;
  }

  /**
   * Render message content to HTML with formatting
   * @param {String} content - Message content
   * @param {Object} opts - Options for resolving mentions, etc.
   * @returns {String} - HTML representation of the message
   */
  toHTML(content, opts = {}) {
    if (!content) return '';

    let html = content;

    // Escape HTML entities
    html = this._escapeHTML(html);

    // Replace code blocks with HTML
    html = html.replace(this.codeBlockRegex, (match, language, code) => {
      return `<pre><code class="language-${language}">${this._escapeHTML(code)}</code></pre>`;
    });

    // Replace inline code with HTML
    html = html.replace(this.inlineCodeRegex, '<code>$1</code>');

    // Replace formatting with HTML
    html = html.replace(this.boldRegex, '<strong>$1</strong>');
    html = html.replace(this.italicRegex, '<em>$1</em>');
    html = html.replace(this.strikethroughRegex, '<del>$1</del>');

    // Replace URLs with links
    html = html.replace(this.urlRegex, (url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });

    // Replace mentions with links if resolveMember is provided
    if (this.resolveMember) {
      html = html.replace(this.mentionRegex, (match, name) => {
        const member = this.resolveMember(name);
        if (member) {
          return `<span class="mention" data-user-id="${member.id}">@${member.displayName}</span>`;
        }
        return `<span class="mention">@${name}</span>`;
      });
    }

    // Replace channel references with links if resolveChannel is provided
    if (this.resolveChannel) {
      html = html.replace(this.channelRegex, (match, name) => {
        const channel = this.resolveChannel(name);
        if (channel) {
          return `<span class="channel" data-channel-id="${channel.id}">#${channel.name}</span>`;
        }
        return `<span class="channel">#${name}</span>`;
      });
    }

    // Replace emojis with images if resolveEmoji is provided
    if (this.resolveEmoji) {
      html = html.replace(this.emojiRegex, (match, name) => {
        const emoji = this.resolveEmoji(name);
        if (emoji) {
          return `<img class="emoji" alt=":${name}:" title=":${name}:" src="${emoji.url}" />`;
        }
        return match;
      });
    }

    // Convert newlines to <br> tags
    html = html.replace(/\n/g, '<br>');

    return html;
  }

  /**
   * Escape HTML special characters
   * @private
   * @param {String} html - The string to escape
   * @returns {String} - Escaped string
   */
  _escapeHTML(html) {
    if (!html) return '';
    return html
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Create a MessageFormatter instance with context from a GigaRoom
   * This allows the formatter to resolve mentions, channels, etc.
   * @param {GigaRoom} room - The room to use for context
   * @returns {MessageFormatter} - A new formatter with context
   */
  static forRoom(room) {
    return new MessageFormatter({
      resolveMember: (name) => {
        if (!room._members) return null;
        return room._members.find(m => m.displayName === name);
      },

      resolveChannel: (name) => {
        if (!room._channels) return null;
        return room._channels.find(c => c.name === name);
      },

      resolveEmoji: (name) => {
        // Custom emoji implementation would go here
        return null;
      }
    });
  }
}

module.exports = MessageFormatter;
