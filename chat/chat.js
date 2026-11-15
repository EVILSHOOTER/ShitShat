import { joinRoom } from 'https://esm.run/trystero@0.26.0';

// All visitors must use the same app ID and room ID.
const roomConfig = document.getElementById('chatWidget')?.dataset || {};
// All participants in a room must use matching IDs.
const APP_ID = roomConfig.appId?.trim() || 'com.example.my-website-chat-2026';
const ROOM_ID = roomConfig.roomId?.trim() || 'public-lobby';
const configNumber = (key, fallback, min, max) => {
  const raw = roomConfig[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
};
const configBoolean = (key, fallback) => roomConfig[key] === 'true' ? true : roomConfig[key] === 'false' ? false : fallback;
const configChoice = (key, values, fallback) => values.includes(roomConfig[key]) ? roomConfig[key] : fallback;
const MAX_HISTORY = configNumber('historyLimit', 300, 50, 1000);
const DEFAULT_NAME_COLOUR = '#a5c4ff';
const DEFAULT_BUBBLE_COLOUR = '#304f92';
const validColour = value => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;
const FONTS = {sans: 'system-ui, sans-serif', serif: 'Georgia, serif', mono: 'ui-monospace, monospace', comic: 'Comic Sans MS, Comic Sans, cursive', cursive: 'cursive'};
const SIZES = {small: '.85em', normal: '1em', large: '1.25em', xlarge: '1.6em'};
const HISTORY_SYNC_LIMIT = 100;
const AWAY_AFTER_MS = configNumber('awayMinutes', 5, 1, 60) * 60 * 1000;
const AVATAR_DATA_LIMIT = 18000;
const IMAGE_DATA_LIMIT = 75000; // compressed data URL, kept small for peer-to-peer transport
const LONG_MESSAGE_CHARS = configNumber('longMessageChars', 450, 100, 5000);
const LONG_MESSAGE_LINES = configNumber('longMessageLines', 7, 2, 30);
const validAvatar = value => typeof value === 'string' && value.length <= AVATAR_DATA_LIMIT &&
  /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
const $ = id => document.getElementById(id);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const peers = new Map();
const ignoredPeers = new Set();
const history = [];
const privateHistory = new Map();
const privateUnread = new Map();
const typingPeers = new Map(); // peerId -> {conversation, expires}
const readStates = new Map(); // messageId -> Map(peerId, {status, ts})
const pendingSeen = new Map();
const reactions = new Map(); // message ID -> Map(peer ID, emoji)
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀'];
let sendReaction = null;
function addPing(name) {
  const input = $('messageInput');
  const mention = '@[' + name + '] ';
  const pos = input.selectionStart ?? input.value.length;
  const prefix = pos > 0 && !/\s/.test(input.value[pos - 1]) ? ' ' : '';
  input.setRangeText(prefix + mention, pos, input.selectionEnd ?? pos, 'end');
  input.focus();
  input.dispatchEvent(new Event('input', {bubbles: true}));
}
function reactionFor(entry, emoji) {
  if (!room || !REACTION_EMOJIS.includes(emoji)) return;
  const mine = reactions.get(entry.id) || new Map();
  const next = mine.get(sessionId) === emoji ? null : emoji;
  if (next) mine.set(sessionId, next); else mine.delete(sessionId);
  reactions.set(entry.id, mine);
  renderMessages();
  if (sendReaction) {
    const target = activeConversation;
    Promise.resolve(sendReaction({id: entry.id, emoji: next, context: target === null ? 'public' : 'private'},
      target === null ? undefined : {target})).catch(console.warn);
  }
}
 // messageId -> {peerId, conversation}
let sendTyping = null;
let sendReceipt = null;
let sendPresence = null;
let lastActivity = Date.now();
let lastPresenceAway = null;
let pendingImage = null;
let pendingReply = null;
let typingTimer = null;
let lastTypingSent = 0;
let lastTypingContext = null;
let activeConversation = null; // null means public room
const knownIds = new Set();
const sessionId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
let sequence = 0;
let myName = '';
let room = null;
let sendChat = null;
let sendPrivate = null;
let sendName = null;
let sendHistoryRequest = null;
let sendHistoryResponse = null;
let joining = false;
let everHadPeer = false;
function setConnectionStatus(state) {
  if (state === 'connected') everHadPeer = true;
  const label = {connecting:'Connecting…', waiting: everHadPeer ? 'Re-connecting…' : 'Connecting…', connected:'Connected', disconnected:'Disconnected'};
  const el = $('status'); el.textContent = label[state] || 'Disconnected';
  el.dataset.connection = state;
  el.title = state === 'waiting' ? 'No peers currently connected. Waiting for another visitor; signaling connectivity cannot be verified here.' :
    state === 'connected' ? 'Connected to at least one peer' : '';
}
window.addEventListener('offline', () => setConnectionStatus('disconnected'));
window.addEventListener('online', () => { if (room) setConnectionStatus(peers.size ? 'connected' : 'waiting'); });

let unreadMessages = 0;
let sidebarWidth = configNumber('sidebarWidth', 130, 65, 500);
let syncPending = false;
let syncCompleted = false;
let syncTimer = null;
const panel = $('chatPanel');
const toggle = $('chatToggle');
const badge = $('chatBadge');
const content = $('chatContent');
const messageBox = $('messages');

function openAvatarPreview(source, name) {
  const preview = $('avatarLightbox');
  const holder = $('avatarLightboxImage');
  holder.replaceChildren();
  const image = makeAvatar(source, name, false);
  image.classList.add('avatar-large');
  holder.append(image);
  $('avatarLightboxName').textContent = name || 'User';
  preview.hidden = false;
  $('avatarLightboxClose').focus();
}
$('avatarLightboxClose').addEventListener('click', () => { $('avatarLightbox').hidden = true; });
$('avatarLightbox').addEventListener('click', e => { if (e.target === $('avatarLightbox')) $('avatarLightbox').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('avatarLightbox').hidden) $('avatarLightbox').hidden = true; });
function clickableAvatar(source, name, inList = false) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'avatar-open';
  button.title = 'View ' + name + "'s profile picture";
  button.setAttribute('aria-label', button.title);
  button.append(makeAvatar(source, name, inList));
  button.addEventListener('click', () => openAvatarPreview(source, name));
  return button;
}
function makeAvatar(source, name, inList = false) {
  const el = document.createElement('span');
  el.className = 'avatar' + (inList ? ' user-avatar' : ' message-avatar');
  const safe = validAvatar(source);
  if (safe) {
    const img = document.createElement('img'); img.src = safe; img.alt = '';
    el.append(img);
  } else {
    el.classList.add('avatar-fallback');
    el.textContent = (String(name || '?').trim().charAt(0) || '?').toUpperCase();
  }
  return el;
}
async function prepareAvatar(file) {
  if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 8 * 1024 * 1024)
    throw new Error('Choose a PNG, JPEG, WebP or GIF smaller than 8 MB.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Image processing is unavailable.');
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    ctx.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2,
      side, side, 0, 0, 96, 96);
    for (const quality of [.75, .55, .35]) {
      const result = canvas.toDataURL('image/jpeg', quality);
      if (validAvatar(result)) return result;
    }
    throw new Error('Could not compress that picture enough.');
  } finally { URL.revokeObjectURL(url); }
}
async function announceProfile() {
  if (room && sendName) {
    try { await sendName({name: myName, nameColour, avatar}); }
    catch (error) { console.warn('Could not announce profile picture:', error); }
  }
}
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
function isOpen() { return !panel.hidden; }
function scrollBottom() { messageBox.scrollTop = messageBox.scrollHeight; }
function currentHistory() { return activeConversation === null ? history : (privateHistory.get(activeConversation) || []); }
function switchConversation(peerId = null) {
  activeConversation = peerId;
  if (peerId !== null) privateUnread.delete(peerId);
  $('conversationTitle').textContent = peerId === null ? 'Public room' : `Private · ${peers.get(peerId)?.name || privateHistory.get(peerId)?.[0]?.name || 'User'}`;
  $('backToPublic').hidden = peerId === null;
  $('messageInput').placeholder = peerId === null ? 'Message everyone... (Enter to send)' : 'Private message... (Enter to send)';
  $('messageInput').disabled = !room || (peerId !== null && !peers.has(peerId));
  $('sendBtn').disabled = $('messageInput').disabled;
  clearReply();
  renderUsers(); renderMessages();
  refreshTypingIndicator(); markConversationSeen(); announceTyping(false);
  requestAnimationFrame(scrollBottom);
}
function setChatOpen(open) {
  panel.hidden = !open;
  toggle.hidden = open;
  toggle.setAttribute('aria-expanded', String(open));
  if (open) {
    unreadMessages = 0;
    badge.hidden = true;
    badge.textContent = '0';
    requestAnimationFrame(() => { setSidebarWidth(sidebarWidth); scrollBottom(); });
    markConversationSeen();
  }
}
toggle.addEventListener('click', () => setChatOpen(true));
$('chatMinimize').addEventListener('click', () => setChatOpen(false));
function markUnread() {
  if (isOpen()) return;
  badge.hidden = false;
  badge.textContent = String(Math.min(++unreadMessages, 99)) + (unreadMessages > 99 ? '+' : '');
}

// Strict, small wire format: never send HTML or evaluate user-provided markup.
function cleanMessage(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' ||
      item.id.length > 140 || typeof item.text !== 'string' ||
      typeof item.name !== 'string' || typeof item.ts !== 'number' ||
      !Number.isFinite(item.ts)) return null;
  const text = item.text.slice(0, 2000);
  const image = typeof item.image === 'string' && item.image.length <= IMAGE_DATA_LIMIT &&
    /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.image) ? item.image : null;
  if (!text.trim() && !image) return null;
  return {
    type: 'message', id: item.id, name: item.name.slice(0, 24) || 'Guest',
    text, image, ts: clamp(item.ts, 0, Date.now() + 60000),
    peerId: typeof item.peerId === 'string' ? item.peerId.slice(0, 140) : '',
    mine: false,
    nameColour: validColour(item.nameColour) || DEFAULT_NAME_COLOUR,
    bubbleColour: validColour(item.bubbleColour) || DEFAULT_BUBBLE_COLOUR,
    avatar: validAvatar(item.avatar),
    replyTo: typeof item.replyTo === 'string' ? item.replyTo.slice(0, 140) : null,
    replyName: typeof item.replyName === 'string' ? item.replyName.slice(0, 24) : null,
    replyText: typeof item.replyText === 'string' ? item.replyText.slice(0, 160) : null
  };
}
function appendHistory(entry, unread = false) {
  if (entry.type === 'message') {
    if (knownIds.has(entry.id)) return false;
    knownIds.add(entry.id);
  }
  history.push(entry);
  if (history.length > MAX_HISTORY) {
    for (const removed of history.splice(0, history.length - MAX_HISTORY)) {
      if (removed.type === 'message') knownIds.delete(removed.id);
    }
  }
  if (activeConversation === null) renderMessages();
  if (unread && !ignoredPeers.has(entry.peerId)) markUnread();
  return true;
}
function addSystem(text) { appendHistory({type: 'system', text}); }
function appendPrivate(peerId, entry, unread = false) {
  if (!privateHistory.has(peerId)) privateHistory.set(peerId, []);
  const items = privateHistory.get(peerId);
  if (items.some(e => e.id === entry.id)) return;
  items.push(entry);
  if (items.length > MAX_HISTORY) items.splice(0, items.length - MAX_HISTORY);
  if (unread && activeConversation !== peerId) {
    privateUnread.set(peerId, (privateUnread.get(peerId) || 0) + 1);
    markUnread();
    renderUsers();
  }
  if (activeConversation === peerId) renderMessages();
}

function addMessage(name, text, mine = false, peerId = '', wire = null) {
  const item = wire || {id: `${sessionId}:${++sequence}`, name, text, ts: Date.now(), peerId, nameColour, bubbleColour, avatar};
  const entry = cleanMessage(item);
  if (!entry) return null;
  entry.mine = mine;
  entry.peerId = peerId || entry.peerId;
  appendHistory(entry, !mine);
  return entry;
}

// Lightweight formatting, deliberately restricted to safe text nodes and links.
const tokenPattern = /(\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\|\|([^|\n]+)\|\||`([^`\n]+)`|\*([^*\n]+)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+))/g;
function renderFormatted(text, target) {
  let pos = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const at = match.index;
    if (at > pos) target.append(document.createTextNode(text.slice(pos, at)));
    let node;
    if (match[2]) { node = document.createElement('strong'); node.textContent = match[2]; }
    else if (match[3]) { node = document.createElement('s'); node.textContent = match[3]; }
    else if (match[4]) {
      node = document.createElement('span'); node.className = 'spoiler';
      node.textContent = match[4]; node.title = 'Click to reveal spoiler';
      node.tabIndex = 0; node.setAttribute('role', 'button');
      const reveal = () => node.classList.toggle('revealed');
      node.addEventListener('click', reveal);
      node.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reveal(); } });
    }
    else if (match[5]) { node = document.createElement('code'); node.textContent = match[5]; }
    else if (match[6]) { node = document.createElement('em'); node.textContent = match[6]; }
    else {
      node = document.createElement('a');
      const url = match[8] || match[9];
      try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw Error(); node.href = parsed.href; }
      catch { node = document.createTextNode(match[0]); }
      if (node.nodeType === 1) { node.textContent = match[7] || match[9]; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
    }
    target.append(node);
    pos = at + match[0].length;
  }
  if (pos < text.length) target.append(document.createTextNode(text.slice(pos)));
}
// Parse safe, limited formatting tags. Never inject HTML from messages.
// Tags can nest; malformed tags are rendered as ordinary text.
function renderRichText(text, target) {
  const pattern = /\[(font|size|color)=([^\]\r\n]{1,30})\]|\[\/(font|size|color)\]/gi;
  const stack = [{kind: null, value: null, node: target}];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const top = stack[stack.length - 1];
    if (match.index > last) renderFormatted(text.slice(last, match.index), top.node);
    if (match[1]) {
      const kind = match[1].toLowerCase();
      const value = match[2].toLowerCase();
      const allowed = kind === 'font' ? FONTS[value] : kind === 'size' ? SIZES[value] : validColour(value);
      if (allowed && stack.length < 12) {
        const span = document.createElement('span');
        if (kind === 'font') span.style.fontFamily = allowed;
        if (kind === 'size') span.style.fontSize = allowed;
        if (kind === 'color') span.style.color = allowed;
        top.node.append(span);
        stack.push({kind, value, node: span});
      } else renderFormatted(match[0], top.node);
    } else if (stack.length > 1 && stack[stack.length - 1].kind === match[3].toLowerCase()) {
      stack.pop();
    } else renderFormatted(match[0], top.node);
    last = match.index + match[0].length;
  }
  if (last < text.length) renderFormatted(text.slice(last), stack[stack.length - 1].node);
}
function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}
function clearReply() {
  pendingReply = null;
  $('replyPreview').hidden = true;
}
function setReply(entry) {
  pendingReply = {replyTo: entry.id, replyName: entry.name, replyText: (entry.text || '[image]').slice(0, 160)};
  $('replyPreviewText').textContent = `Replying to ${entry.name}: ${pendingReply.replyText}`;
  $('replyPreview').hidden = false;
  $('messageInput').focus();
}
$('cancelReply').addEventListener('click', clearReply);
// Bracketed mentions keep names containing spaces unambiguous.
// Legacy @Name mentions remain supported for compatibility.
function isMentioned(text) {
  if (!myName || !text) return false;
  const bracketed = /@\[([^\]\r\n]{1,40})\]/g;
  for (const match of text.matchAll(bracketed)) {
    if (match[1].toLocaleLowerCase() === myName.toLocaleLowerCase()) return true;
  }
  const escaped = myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^\\w])@' + escaped + '(?![\\w])', 'i').test(text);
}
function decorateMentions(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement?.closest('a,code,button')) continue;
    const pattern = /@\[([^\]\r\n]{1,40})\]|@([\w.-]+)/g;
    const value = node.textContent;
    if (!pattern.test(value)) continue;
    pattern.lastIndex = 0;
    const frag = document.createDocumentFragment(); let last = 0, match;
    while ((match = pattern.exec(value))) {
      frag.append(document.createTextNode(value.slice(last, match.index)));
      const span = document.createElement('span'); span.className = 'chat-mention';
      span.textContent = '@' + (match[1] || match[2]); frag.append(span); last = pattern.lastIndex;
    }
    frag.append(document.createTextNode(value.slice(last)));
    node.replaceWith(frag);
  }
}
function renderMessages() {
  const nearBottom = messageBox.scrollHeight - messageBox.scrollTop - messageBox.clientHeight < 70;
  const fragment = document.createDocumentFragment();
  const entries = currentHistory();
  for (let i = 0; i < entries.length;) {
    const entry = entries[i];
    if (entry.type === 'message' && !entry.mine && ignoredPeers.has(entry.peerId)) {
      const peerId = entry.peerId;
      let count = 0;
      while (i < entries.length && entries[i].type === 'message' &&
             !entries[i].mine && entries[i].peerId === peerId && ignoredPeers.has(peerId)) { count++; i++; }
      const el = document.createElement('div'); el.className = 'ignored-message';
      const label = document.createElement('span'); label.textContent = `${entry.name}: ${count} message${count === 1 ? '' : 's'} ignored`;
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Unignore';
      button.addEventListener('click', () => setIgnored(peerId, false));
      el.append(label, button); fragment.append(el); continue;
    }
    if (entry.type === 'system') {
      const el = document.createElement('div'); el.className = 'system'; el.textContent = entry.text;
      fragment.append(el);
    } else {
      const el = document.createElement('div'); el.className = 'message' + (entry.mine ? ' mine' : '');
      if (!entry.mine && isMentioned(entry.text)) el.classList.add('mentioned-me');
      // On touch devices, tap the message itself to reveal its actions; tapping again hides them.
      // Do not intercept links, username mentions, reactions or other controls.
      el.addEventListener('click', event => {
        if (!window.matchMedia('(hover: none)').matches) return;
        if (event.target.closest('button, a, input, select, textarea')) return;
        const wasOpen = el.classList.contains('touch-actions-open');
        messageBox.querySelectorAll('.message.touch-actions-open').forEach(node => node.classList.remove('touch-actions-open'));
        if (!wasOpen) el.classList.add('touch-actions-open');
      });
      const layout = document.createElement('div'); layout.className = 'message-layout';
      if (!hideAvatars) layout.append(clickableAvatar(entry.avatar || (!entry.mine ? peers.get(entry.peerId)?.avatar : avatar), entry.name, false));
      const messageContent = document.createElement('div'); messageContent.className = 'message-content';
      const meta = document.createElement('div'); meta.className = 'message-meta';
      const author = document.createElement('button'); author.type = 'button'; author.className = 'author author-ping'; author.textContent = entry.name; author.title = 'Mention @' + entry.name; author.style.color = entry.nameColour || DEFAULT_NAME_COLOUR; author.addEventListener('click', () => addPing(entry.name));
      const time = document.createElement('time'); time.className = 'message-time';
      time.dateTime = new Date(entry.ts).toISOString(); time.textContent = timeLabel(entry.ts);
      const body = document.createElement('div'); body.className = 'message-body';
      if (entry.replyTo) {
        const quote = document.createElement('button'); quote.type = 'button'; quote.className = 'message-reply-quote';
        quote.textContent = `↳ ${entry.replyName || 'User'}: ${entry.replyText || '[message]'}`;
        quote.title = 'Jump to original message';
        quote.addEventListener('click', () => {
          const original = Array.from(messageBox.querySelectorAll('[data-message-id]')).find(n => n.dataset.messageId === entry.replyTo);
          if (original) { original.scrollIntoView({block:'center',behavior:'smooth'}); original.classList.add('reply-flash'); setTimeout(() => original.classList.remove('reply-flash'), 1200); }
        });
        body.append(quote);
      }
      if (entry.text) {
        const long = entry.text.length > LONG_MESSAGE_CHARS || entry.text.split('\n').length > LONG_MESSAGE_LINES;
        if (long) {
          const clipped = document.createElement('div'); clipped.className = 'message-text-clipped';
          renderRichText(entry.text, clipped); body.append(clipped);
          const more = document.createElement('button'); more.type = 'button'; more.className = 'read-more'; more.textContent = 'Read more';
          more.addEventListener('click', () => {
            const expanded = clipped.classList.toggle('expanded');
            more.textContent = expanded ? 'Read less' : 'Read more';
          });
          body.append(more);
        } else renderRichText(entry.text, body);
      }
      if (entry.image) {
        const imageWrap = document.createElement('div'); imageWrap.className = 'message-image-wrap';
        const img = document.createElement('img'); img.className = 'message-image'; img.src = entry.image;
        img.alt = 'Shared chat image'; img.loading = 'lazy';
        const reveal = document.createElement('button'); reveal.type = 'button'; reveal.className = 'image-reveal';
        reveal.textContent = 'Show image';
        reveal.addEventListener('click', () => {
          const hidden = imageWrap.classList.toggle('image-concealed');
          reveal.textContent = hidden ? 'Show image' : 'Hide image';
        });
        imageWrap.append(img, reveal);
        if (hideImages) imageWrap.classList.add('image-concealed');
        body.append(imageWrap);
      }
      decorateMentions(body);
      el.dataset.messageId = entry.id;
      const replyButton = document.createElement('button'); replyButton.type = 'button'; replyButton.className = 'reply-action'; replyButton.textContent = '↩ Reply';
      replyButton.addEventListener('click', () => setReply(entry));
      // Standard mode: actions precede the timestamp. Compact mode: actions follow the message text.
      const reactButton = document.createElement('button'); reactButton.type = 'button'; reactButton.className = 'react-action'; reactButton.textContent = '☺+'; reactButton.title = 'React to message';
      const picker = document.createElement('div'); picker.className = 'reaction-picker'; picker.hidden = true;
      for (const emoji of REACTION_EMOJIS) {
        const option = document.createElement('button'); option.type = 'button'; option.textContent = emoji; option.title = 'React ' + emoji;
        option.addEventListener('click', () => reactionFor(entry, emoji)); picker.append(option);
      }
      reactButton.addEventListener('click', () => { picker.hidden = !picker.hidden; });
      const reactionBar = document.createElement('div'); reactionBar.className = 'reaction-bar';
      const counts = new Map();
      for (const emoji of (reactions.get(entry.id) || new Map()).values()) counts.set(emoji, (counts.get(emoji) || 0) + 1);
      for (const [emoji, count] of counts) {
        const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'reaction-chip';
        if (reactions.get(entry.id)?.get(sessionId) === emoji) chip.classList.add('mine-reaction');
        chip.textContent = `${emoji} ${count}`; chip.title = 'Toggle ' + emoji + ' reaction';
        chip.addEventListener('click', () => reactionFor(entry, emoji)); reactionBar.append(chip);
      }
      body.append(reactionBar, picker);
      el.style.backgroundColor = entry.bubbleColour || (entry.mine ? DEFAULT_BUBBLE_COLOUR : 'var(--received-bubble)');
      const right = document.createElement('div'); right.className = 'message-meta-right';
      if (compactMode) {
        const inlineActions = document.createElement('span');
        inlineActions.className = 'compact-message-actions';
        inlineActions.append(replyButton, reactButton);
        body.append(inlineActions);
        right.append(time);
      } else {
        right.append(replyButton, reactButton, time);
      }
      if (entry.mine) {
        const receipt = document.createElement('span'); receipt.className = 'message-receipt';
        const statuses = readStates.get(entry.id) || new Map();
        const recipients = activeConversation === null ? Array.from(statuses.entries()) :
          Array.from(statuses.entries()).filter(([id]) => id === activeConversation);
        const seen = recipients.filter(([,v]) => v.status === 'seen');
        receipt.textContent = seen.length ? '✓✓' : '✓';
        if (seen.length) receipt.classList.add('seen');
        const details = recipients.length ? recipients.map(([id,v]) =>
          `${peers.get(id)?.name || v.name || 'User'}: ${v.status === 'seen' ? 'Seen' : 'Delivered'} at ${new Date(v.ts).toLocaleString()}`).join('\n') :
          'Sent (delivery not yet confirmed)';
        receipt.title = (seen.length ? 'Seen by:\n' : 'Delivery details:\n') + details;
        receipt.setAttribute('aria-label', receipt.title);
        if (!hideReceipts) right.append(receipt);
      }
      meta.append(author, right); messageContent.append(meta, body); layout.append(messageContent); el.append(layout); fragment.append(el);
    }
    i++;
  }
  messageBox.replaceChildren(fragment);
  if (isOpen() && nearBottom) scrollBottom();
}
function setIgnored(peerId, ignored) {
  // Allow unignoring someone after they have disconnected, via the placeholder.
  if (ignored) ignoredPeers.add(peerId); else ignoredPeers.delete(peerId);
  renderUsers(); renderMessages(); refreshTypingIndicator();
}
function renderUsers() {
  const list = $('users'); list.replaceChildren();
  if (!room) { $('count').textContent = '0'; return; }
  const users = [{id: null, name: myName, me: true},
    ...Array.from(peers, ([id, peer]) => ({id, name: peer.name || 'Connecting...', me: false}))];
  users.sort((a, b) => a.me ? -1 : b.me ? 1 : a.name.localeCompare(b.name));
  for (const user of users) {
    const ignored = Boolean(user.id && ignoredPeers.has(user.id));
    const li = document.createElement('li');
    const away = !user.me && Boolean(peers.get(user.id)?.away);
    const userAvatar = user.me ? avatar : peers.get(user.id)?.avatar;
    const dot = clickableAvatar(userAvatar, user.name, true);
    dot.firstElementChild.classList.toggle('away', away);
    dot.title = (away ? 'Away · ' : 'Online · ') + 'View ' + user.name + "'s picture";
    const name = document.createElement('span'); name.className = 'user-name' + (ignored ? ' ignored' : '');
    name.textContent = user.name + (user.me ? ' (you)' : ''); name.title = user.name;
    if (!ignored) name.style.color = user.me ? nameColour : (peers.get(user.id)?.nameColour || '');
    li.append(dot, name);
    if (!user.me && user.id) {
      const dm = document.createElement('button'); dm.type = 'button';
      dm.className = 'dm-button' + (activeConversation === user.id ? ' active' : '');
      const unread = privateUnread.get(user.id) || 0;
      dm.textContent = unread ? `✉ ${unread > 99 ? '99+' : unread}` : '✉';
      dm.title = `Private message ${user.name}`; dm.setAttribute('aria-label', dm.title);
      dm.addEventListener('click', () => switchConversation(user.id));
      li.append(dm);
    }
    if (!user.me && user.id) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'ignore-button' + (ignored ? ' active' : '');
      button.textContent = ignored ? '✕' : '◉';
      button.title = (ignored ? 'Unignore ' : 'Ignore ') + user.name;
      button.setAttribute('aria-label', button.title); button.setAttribute('aria-pressed', String(ignored));
      button.addEventListener('click', () => setIgnored(user.id, !ignored)); li.append(button);
    }
    list.append(li);
  }
  $('count').textContent = String(users.length);
}

// Typing indicators are ephemeral and are scoped to the public room or a DM.
function announceTyping(active) {
  if (!room || !sendTyping) return;
  const context = activeConversation === null ? 'public' : 'private';
  const target = activeConversation;
  const key = `${context}:${target || ''}`;
  const now = Date.now();
  if (active && lastTypingContext === key && now - lastTypingSent < 1200) return;
  lastTypingSent = now; lastTypingContext = active ? key : null;
  const payload = {active, context, name: myName};
  Promise.resolve().then(() => context === 'public' ? sendTyping(payload) :
    (peers.has(target) ? sendTyping(payload, {target}) : null)).catch(console.warn);
}
function refreshTypingIndicator() {
  const el = $('typingIndicator');
  const now = Date.now();
  const context = activeConversation === null ? 'public' : 'private';
  const names = [];
  for (const [id, value] of typingPeers) {
    if (value.expires <= now) { typingPeers.delete(id); continue; }
    if (ignoredPeers.has(id)) continue;
    if (value.context !== context) continue;
    if (context === 'private' && activeConversation !== id) continue;
    names.push(peers.get(id)?.name || 'Someone');
  }
  el.hidden = hideTyping || names.length === 0;
  if (!el.hidden) el.textContent = names.length === 1 ? `${names[0]} is typing…` :
    `${names.slice(0, 2).join(' and ')}${names.length > 2 ? ` and ${names.length - 2} others` : ''} are typing…`;
}
function queueSeen(peerId, entryId, context) {
  if (ignoredPeers.has(peerId)) return;
  pendingSeen.set(entryId, {peerId, context});
  markConversationSeen();
}
function markConversationSeen() {
  if (!room || !sendReceipt || !isOpen() || !$('settingsScreen').hidden || document.visibilityState !== 'visible') return;
  const context = activeConversation === null ? 'public' : 'private';
  for (const [id, item] of pendingSeen) {
    if (item.context !== context || (context === 'private' && item.peerId !== activeConversation)) continue;
    if (ignoredPeers.has(item.peerId) || !peers.has(item.peerId)) continue;
    pendingSeen.delete(id);
    Promise.resolve().then(() => sendReceipt({id, status: 'seen', ts: Date.now()}, {target: item.peerId})).catch(console.warn);
  }
}
function receiptFor(peerId, id, status) {
  if (!sendReceipt || !peers.has(peerId)) return;
  Promise.resolve().then(() => sendReceipt({id, status, ts: Date.now()}, {target: peerId})).catch(console.warn);
}

// History is exchanged directly between connected browsers, not stored on a server.
// Only the first valid reply to a join-time request is used; up to 100 latest messages.
function historySnapshot() {
  return history.filter(e => e.type === 'message' && e.text?.trim()).slice(-HISTORY_SYNC_LIMIT)
    .map(({id, name, text, ts, peerId, nameColour, bubbleColour, avatar, replyTo, replyName, replyText}) => ({id, name, text, ts, peerId, nameColour, bubbleColour, avatar, replyTo, replyName, replyText}));
}
function requestHistory(peerId) {
  if (syncCompleted || syncPending || !sendHistoryRequest) return;
  syncPending = true;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncPending = false; }, 3500);
  Promise.resolve().then(() => sendHistoryRequest({requester: sessionId}, {target: peerId}))
    .catch(err => { syncPending = false; console.warn('History request failed', err); });
}
function mergeHistory(messages) {
  if (!Array.isArray(messages)) return false;
  const valid = messages.slice(-HISTORY_SYNC_LIMIT).map(cleanMessage).filter(Boolean);
  if (!valid.length) return false;
  for (const entry of valid) {
    if (!knownIds.has(entry.id)) { knownIds.add(entry.id); history.push(entry); }
  }
  history.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  knownIds.clear();
  for (const e of history) if (e.type === 'message') knownIds.add(e.id);
  renderMessages();
  return true;
}

async function startChat() {
  if (room || joining) return;
  const chosen = $('username').value.trim();
  if (!chosen) { $('joinError').textContent = 'Please enter your name.'; return; }
  joining = true; myName = chosen.slice(0, 24); setConnectionStatus('connecting');
  $('joinError').textContent = ''; $('joinBtn').disabled = true; $('joinBtn').textContent = 'Joining...';
  try {
    room = joinRoom({appId: APP_ID}, ROOM_ID);
    // This installed Trystero version exposes object-style actions.
    const chatAction = room.makeAction('chat');
    const nameAction = room.makeAction('name');
    const privateAction = room.makeAction('private-chat');
    const requestAction = room.makeAction('history-request');
    const responseAction = room.makeAction('history-response');
    const reactionAction = room.makeAction('message-reaction');
    sendReaction = reactionAction.send;
    reactionAction.onMessage = (data, {peerId} = {}) => {
      if (!peers.has(peerId) || typeof data?.id !== 'string' || data.id.length > 140 ||
          !['public','private'].includes(data.context) ||
          (data.emoji !== null && !REACTION_EMOJIS.includes(data.emoji))) return;
      const entries = data.context === 'public' ? history : (privateHistory.get(peerId) || []);
      if (!entries.some(e => e.type === 'message' && e.id === data.id)) return;
      const votes = reactions.get(data.id) || new Map();
      if (data.emoji) votes.set(peerId, data.emoji); else votes.delete(peerId);
      reactions.set(data.id, votes);
      if ((data.context === 'public' && activeConversation === null) ||
          (data.context === 'private' && activeConversation === peerId)) renderMessages();
    };
    const typingAction = room.makeAction('typing-state');
    const presenceAction = room.makeAction('presence-state');
    sendPresence = presenceAction.send;
    presenceAction.onMessage = (data, {peerId} = {}) => {
      if (!peers.has(peerId) || typeof data?.away !== 'boolean') return;
      peers.get(peerId).away = data.away; renderUsers();
    };
    const receiptAction = room.makeAction('read-receipt');
    sendTyping = typingAction.send; sendReceipt = receiptAction.send;
    typingAction.onMessage = (data, {peerId} = {}) => {
      if (!peers.has(peerId) || !['public','private'].includes(data?.context)) return;
      if (data.active) typingPeers.set(peerId, {context: data.context, expires: Date.now() + 2800});
      else typingPeers.delete(peerId);
      refreshTypingIndicator();
    };
    receiptAction.onMessage = (data, {peerId} = {}) => {
      if (!peers.has(peerId) || !['seen','delivered'].includes(data?.status) || typeof data.id !== 'string') return;
      const owned = history.find(e => e.type === 'message' && e.mine && e.id === data.id) ||
        (privateHistory.get(peerId) || []).find(e => e.mine && e.id === data.id);
      if (!owned) return;
      if (!readStates.has(data.id)) readStates.set(data.id, new Map());
      const statuses = readStates.get(data.id);
      if (statuses.get(peerId)?.status === 'seen' && data.status === 'delivered') return;
      statuses.set(peerId, {status: data.status, ts: Date.now(), name: peers.get(peerId)?.name || 'User'});
      if (activeConversation === null || activeConversation === peerId) renderMessages();
    };
    sendChat = chatAction.send; sendName = nameAction.send; sendPrivate = privateAction.send;
    privateAction.onMessage = (data, {peerId} = {}) => {
      if (!peers.has(peerId) || typeof data?.text !== 'string') return;
      const text = data.text.slice(0, 2000); if (!text.trim() && !data.image) return;
      const name = peers.get(peerId).name || 'Guest';
      const entry = cleanMessage({nameColour: validColour(data.nameColour) || peers.get(peerId).nameColour, bubbleColour: data.bubbleColour, avatar: validAvatar(data.avatar) || peers.get(peerId).avatar, replyTo: data.replyTo, replyName: data.replyName, replyText: data.replyText, id: typeof data.id === 'string' ? data.id : `${peerId}:${Date.now()}:${Math.random()}`, name, text, image: data.image, ts: Number.isFinite(data.ts) ? data.ts : Date.now(), peerId});
      if (entry) {
        appendPrivate(peerId, entry, !ignoredPeers.has(peerId));
        receiptFor(peerId, entry.id, 'delivered');
        queueSeen(peerId, entry.id, 'private');
      }
      typingPeers.delete(peerId); refreshTypingIndicator();
    }; 
    sendHistoryRequest = requestAction.send; sendHistoryResponse = responseAction.send;
    chatAction.onMessage = (data, {peerId} = {}) => {
      if (!peers.has(peerId) || typeof data?.text !== 'string') return;
      const text = data.text.slice(0, 2000);
      if (!text.trim() && !data.image) return;
      const name = peers.get(peerId).name || 'Guest';
      const entry = addMessage(name, text, false, peerId, {
        id: typeof data.id === 'string' ? data.id : `${peerId}:${Date.now()}:${Math.random()}`,
        name, text, image: data.image, ts: Number.isFinite(data.ts) ? data.ts : Date.now(), peerId, nameColour: data.nameColour || peers.get(peerId).nameColour, bubbleColour: data.bubbleColour, avatar: validAvatar(data.avatar) || peers.get(peerId).avatar, replyTo: data.replyTo, replyName: data.replyName, replyText: data.replyText
      });
      if (entry) { receiptFor(peerId, entry.id, 'delivered'); queueSeen(peerId, entry.id, 'public'); }
      typingPeers.delete(peerId); refreshTypingIndicator();
    };
    nameAction.onMessage = (value, {peerId} = {}) => {
      if (!peers.has(peerId)) return;
      const receivedName = typeof value === 'string' ? value : value?.name;
      if (typeof receivedName !== 'string') return;
      const name = receivedName.trim().slice(0, 24); if (!name) return;
      const peer = peers.get(peerId); const firstName = !peer.name; peer.name = name; peer.nameColour = validColour(value?.nameColour) || peer.nameColour || DEFAULT_NAME_COLOUR; peer.avatar = validAvatar(value?.avatar);
      if (firstName) addSystem(name + ' joined the chat');
      if (activeConversation === peerId) $('conversationTitle').textContent = `Private · ${name}`;
      renderUsers(); refreshTypingIndicator();
    };
    requestAction.onMessage = (data, {peerId} = {}) => {
      if (!peers.has(peerId) || !data || typeof data.requester !== 'string') return;
      Promise.resolve().then(() => sendHistoryResponse({requester: data.requester, messages: historySnapshot()}, {target: peerId}))
        .catch(err => console.warn('History response failed', err));
    };
    responseAction.onMessage = (data, {peerId} = {}) => {
      if (!peers.has(peerId) || !syncPending || syncCompleted || data?.requester !== sessionId) return;
      if (!Array.isArray(data.messages)) return;
      if (mergeHistory(data.messages)) {
        syncCompleted = true; syncPending = false; clearTimeout(syncTimer);
        addSystem('Recent messages loaded from another online user.');
      }
    };
    room.onPeerJoin = peerId => {
      setConnectionStatus('connected');
      peers.set(peerId, {name: '', away: false});
      announcePresence(peerId);
      if (activeConversation === peerId) { $('messageInput').disabled = false; $('sendBtn').disabled = false; }
      renderUsers();
      Promise.resolve().then(() => sendName({name: myName, nameColour, avatar}, {target: peerId}))
        .catch(err => console.warn('Could not send name', err));
      // Request from the first connected peer with available history.
      requestHistory(peerId);
    };
    room.onPeerLeave = peerId => {
      const peer = peers.get(peerId);
      if (peer?.name) addSystem(peer.name + ' left the chat');
      peers.delete(peerId); typingPeers.delete(peerId); refreshTypingIndicator(); renderUsers();
      if (activeConversation === peerId) {
        $('messageInput').disabled = true; $('sendBtn').disabled = true;
        $('conversationTitle').textContent += ' (offline)';
      }
      if (!syncCompleted) syncPending = false;
      if (peers.size === 0) setConnectionStatus(navigator.onLine ? 'waiting' : 'disconnected');
    };
    $('joinScreen').hidden = true;
    $('messageInput').disabled = false; $('sendBtn').disabled = false;
    setConnectionStatus(peers.size ? 'connected' : 'waiting');
    $('settingsName').value = myName;
    renderUsers(); addSystem('Welcome, ' + myName + '!');
    addSystem('History may be loaded from another connected browser.');
    $('messageInput').focus();
  } catch (error) {
    console.error('Trystero chat startup failed:', error);
    if (room) { try { room.leave(); } catch {} room = null; }
    sendChat = sendName = sendPrivate = sendHistoryRequest = sendHistoryResponse = sendTyping = sendReceipt = sendPresence = sendReaction = null;
    peers.clear(); ignoredPeers.clear(); renderUsers();
    setConnectionStatus('disconnected');
    $('joinError').textContent = 'Chat error: ' + (error?.message || String(error));
    $('joinBtn').disabled = false; $('joinBtn').textContent = 'Join Chat';
  } finally { joining = false; }
}
$('joinBtn').addEventListener('click', startChat);
$('username').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); startChat(); } });

$('backToPublic').addEventListener('click', () => {
  switchConversation(null);
  $('messageInput').disabled = !room; $('sendBtn').disabled = !room;
});
$('messageForm').addEventListener('submit', async event => {
  event.preventDefault(); if (!room || !sendChat) return;
  const input = $('messageInput'); const text = input.value.trim();
  const image = pendingImage;
  if (!text && !image) return;
  const reply = pendingReply ? {...pendingReply} : {};
  closeMentionMenu(); input.value = ''; pendingImage = null; clearReply(); updateImagePreview(); announceTyping(false);
  if (activeConversation !== null) {
    const target = activeConversation;
    if (!peers.has(target)) { input.value = text; pendingImage = image; updateImagePreview(); return; }
    const entry = cleanMessage({id: `${sessionId}:${++sequence}`, name: myName, text, image, ts: Date.now(), peerId: target, nameColour, bubbleColour, avatar, ...reply});
    if (!entry) return;
    entry.mine = true; appendPrivate(target, entry);
    try { await sendPrivate({id: entry.id, text, image, ts: entry.ts, nameColour: entry.nameColour, bubbleColour: entry.bubbleColour, avatar: entry.avatar, ...reply}, {target}); }
    catch (error) { console.error('Private message failed:', error); addSystem('Private message delivery failed.'); }
  } else {
    const entry = addMessage(myName, text, true, '', {id: `${sessionId}:${++sequence}`, name: myName, text, image, ts: Date.now(), nameColour, bubbleColour, avatar, ...reply});
    if (!entry) return;
    try { await sendChat({id: entry.id, text, image, ts: entry.ts, nameColour: entry.nameColour, bubbleColour: entry.bubbleColour, avatar: entry.avatar, ...reply}); }
    catch (error) { console.error('Message sending failed:', error); addSystem('Message delivery failed.'); }
  }
});

// Image attachments are compressed locally before sharing. No remote image hosting.
function updateImagePreview() {
  const el = $('imagePreview'); el.replaceChildren(); el.hidden = !pendingImage;
  if (!pendingImage) return;
  const image = document.createElement('img'); image.src = pendingImage; image.alt = 'Image ready to send';
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove image';
  remove.addEventListener('click', () => { pendingImage = null; updateImagePreview(); });
  el.append(image, remove);
}
async function prepareImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > 12 * 1024 * 1024) { alert('Please choose an image under 12 MB.'); return; }
  try {
    const bitmap = await createImageBitmap(file);
    let width = Math.min(bitmap.width, 800);
    let height = Math.max(1, Math.round(bitmap.height * width / bitmap.width));
    if (height > 800) { width = Math.round(width * 800 / height); height = 800; }
    let encoded = null;
    for (let attempt = 0; attempt < 7; attempt++) {
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, width); canvas.height = Math.max(1, height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      encoded = canvas.toDataURL('image/jpeg', Math.max(.4, .82 - attempt * .07));
      if (encoded.length <= IMAGE_DATA_LIMIT) break;
      width = Math.max(64, Math.round(width * .75)); height = Math.max(64, Math.round(height * .75));
    }
    bitmap.close();
    if (!encoded || encoded.length > IMAGE_DATA_LIMIT) throw new Error('Image could not be compressed enough.');
    pendingImage = encoded; updateImagePreview();
  } catch (error) { console.error(error); alert('Could not attach this image. Try a JPEG, PNG or WebP.'); }
}
$('imageAttach').addEventListener('click', () => $('imageFile').click());
$('imageFile').addEventListener('change', async event => {
  await prepareImage(event.target.files?.[0]); event.target.value = '';
});
$('messageInput').addEventListener('paste', event => {
  const file = Array.from(event.clipboardData?.files || []).find(f => f.type.startsWith('image/'));
  if (file) { event.preventDefault(); prepareImage(file); }
});

// Broadcast availability after five minutes without interaction, or when the tab is hidden.
function isAway() { return document.visibilityState !== 'visible' || Date.now() - lastActivity >= AWAY_AFTER_MS; }
function announcePresence(target = null) {
  if (!room || !sendPresence) return;
  const away = isAway(); lastPresenceAway = away;
  Promise.resolve().then(() => target ? sendPresence({away}, {target}) : sendPresence({away})).catch(console.warn);
}
function updatePresence() {
  const away = isAway(); if (lastPresenceAway !== away) announcePresence();
}
function noteActivity() {
  if (document.visibilityState !== 'visible') return;
  lastActivity = Date.now(); updatePresence();
}
['pointerdown','keydown','touchstart','wheel'].forEach(type => document.addEventListener(type, noteActivity, {passive: true}));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') lastActivity = Date.now(); updatePresence(); });
setInterval(updatePresence, 15000);
// Mention suggestions are scoped to the active conversation and never inject HTML.
const mentionMenu = $('mentionSuggestions');
let mentionCandidates = [];
let mentionSelection = 0;
let mentionRange = null;
function closeMentionMenu() {
  mentionMenu.hidden = true; mentionMenu.replaceChildren(); mentionCandidates = []; mentionRange = null;
}
function updateMentionMenu() {
  const input = $('messageInput');
  if (input.disabled || document.activeElement !== input || input.selectionStart !== input.selectionEnd) { closeMentionMenu(); return; }
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const match = /(^|[\s(])@([^@\n\r\[\]]{0,40})$/.exec(before);
  if (!match) { closeMentionMenu(); return; }
  const search = match[2].toLocaleLowerCase();
  const names = [...peers.entries()]
    .filter(([id]) => !ignoredPeers.has(id) && (activeConversation === null || activeConversation === id))
    .map(([, peer]) => typeof peer === 'string' ? peer : peer.name)
    .filter(name => typeof name === 'string' && name.trim());
  const unique = [...new Set(names)];
  mentionCandidates = unique.filter(name => name.toLocaleLowerCase().includes(search)).slice(0, 8);
  if (!mentionCandidates.length) { closeMentionMenu(); return; }
  mentionRange = [caret - match[2].length - 1, caret];
  mentionSelection = Math.min(mentionSelection, mentionCandidates.length - 1);
  mentionMenu.replaceChildren();
  mentionCandidates.forEach((name, index) => {
    const item = document.createElement('button'); item.type = 'button';
    item.className = 'mention-suggestion' + (index === mentionSelection ? ' selected' : '');
    item.textContent = '@' + name;
    item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(index === mentionSelection));
    item.addEventListener('pointerdown', e => e.preventDefault());
    item.addEventListener('click', () => chooseMention(index));
    mentionMenu.append(item);
  });
  mentionMenu.hidden = false;
}
function chooseMention(index) {
  const name = mentionCandidates[index];
  if (!name || !mentionRange) return;
  const input = $('messageInput');
  input.setRangeText('@[' + name + '] ', mentionRange[0], mentionRange[1], 'end');
  closeMentionMenu(); input.focus();
  input.dispatchEvent(new Event('input', {bubbles:true}));
}
$('messageInput').addEventListener('click', updateMentionMenu);
$('messageInput').addEventListener('keyup', e => { if (!['ArrowUp','ArrowDown','Enter','Escape'].includes(e.key)) updateMentionMenu(); });
$('messageInput').addEventListener('blur', () => { setTimeout(() => { if (!mentionMenu.contains(document.activeElement)) closeMentionMenu(); }, 120); });
$('messageInput').addEventListener('input', () => {
  clearTimeout(typingTimer);
  announceTyping(Boolean($('messageInput').value.trim()));
  if ($('messageInput').value.trim()) typingTimer = setTimeout(() => announceTyping(false), 1800);
  updateMentionMenu();
});
setInterval(refreshTypingIndicator, 900);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') markConversationSeen(); });
$('messageInput').addEventListener('keydown', event => {
  if (!mentionMenu.hidden) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); mentionSelection = (mentionSelection + (event.key === 'ArrowDown' ? 1 : -1) + mentionCandidates.length) % mentionCandidates.length; updateMentionMenu(); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); chooseMention(mentionSelection); return; }
    if (event.key === 'Escape') { event.preventDefault(); closeMentionMenu(); return; }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault(); $('messageForm').requestSubmit();
  }
  if ((event.ctrlKey || event.metaKey) && ['b', 'i'].includes(event.key.toLowerCase())) {
    event.preventDefault(); insertFormat(event.key.toLowerCase() === 'b' ? 'bold' : 'italic');
  }
});
function insertFormat(kind) {
  const input = $('messageInput'); if (input.disabled) return;
  const wrappers = {bold: ['**', '**'], italic: ['*', '*'], strike: ['~~', '~~'],
    code: ['`', '`'], spoiler: ['||', '||'], link: ['[', '](https://example.com)']};
  const [before, after] = wrappers[kind] || ['', ''];
  const start = input.selectionStart, end = input.selectionEnd;
  const selected = input.value.slice(start, end) || (kind === 'link' ? 'link text' : 'text');
  input.setRangeText(before + selected + after, start, end, 'select');
  input.setSelectionRange(start + before.length, start + before.length + selected.length);
  input.focus();
}
function applyTextStyle(kind, value) {
  const input = $('messageInput');
  if (input.disabled) return;
  const valid = kind === 'font' ? FONTS[value] : kind === 'size' ? SIZES[value] : validColour(value);
  if (!valid) return;
  const start = input.selectionStart, end = input.selectionEnd;
  const selected = input.value.slice(start, end);
  const opening = `[${kind}=${value}]`;
  const closing = `[/${kind}]`;
  if (input.value.length + opening.length + closing.length > input.maxLength) return;
  input.setRangeText(opening + selected + closing, start, end, 'end');
  if (selected) input.setSelectionRange(start + opening.length, start + opening.length + selected.length);
  else input.setSelectionRange(start + opening.length, start + opening.length);
  input.focus();
}
$('fontPicker').addEventListener('change', event => {
  if (event.target.value) applyTextStyle('font', event.target.value);
  event.target.value = '';
});
$('fontSizePicker').addEventListener('change', event => {
  if (event.target.value) applyTextStyle('size', event.target.value);
  event.target.value = '';
});
$('textColourPicker').addEventListener('input', event => applyTextStyle('color', event.target.value));
// Keep the textarea selection when toolbar controls receive focus.
let savedSelection = [0, 0];
$('messageInput').addEventListener('select', () => { savedSelection = [$('messageInput').selectionStart, $('messageInput').selectionEnd]; });
$('messageInput').addEventListener('keyup', () => { savedSelection = [$('messageInput').selectionStart, $('messageInput').selectionEnd]; });
$('messageInput').addEventListener('click', () => { savedSelection = [$('messageInput').selectionStart, $('messageInput').selectionEnd]; });
document.querySelectorAll('[data-format]').forEach(button => {
  button.addEventListener('click', () => insertFormat(button.dataset.format));
});
const emojis = ['😀','😂','😍','🥳','😎','😭','❤️','👍','👀','🔥','🎉','✨','💀','🤔','🙌','💬'];
for (const emoji of emojis) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = emoji;
  button.addEventListener('click', () => {
    const input = $('messageInput'); input.setRangeText(emoji, input.selectionStart, input.selectionEnd, 'end');
    input.focus(); $('emojiPicker').hidden = true;
  });
  $('emojiPicker').append(button);
}
$('emojiToggle').addEventListener('click', () => { $('emojiPicker').hidden = !$('emojiPicker').hidden; });

// Settings (persisted locally, easy to extend later).
const prefs = load('community-chat-preferences', {});
let density = Number.isFinite(prefs.density) ? clamp(prefs.density, 75, 125) : configNumber('density', 100, 75, 125);
let hideTimes = prefs.hideTimes !== undefined ? Boolean(prefs.hideTimes) : configBoolean('hideTimestamps', false);
let hideTyping = prefs.hideTyping !== undefined ? Boolean(prefs.hideTyping) : configBoolean('hideTyping', false);
let hideImages = prefs.hideImages !== undefined ? Boolean(prefs.hideImages) : configBoolean('hideImages', true);
let hideAvatars = prefs.hideAvatars !== undefined ? Boolean(prefs.hideAvatars) : configBoolean('hideAvatars', false);
let avatar = validAvatar(load('community-chat-avatar', null));
let advancedFormatting = prefs.advancedFormatting !== undefined ? Boolean(prefs.advancedFormatting) : configBoolean('advancedFormatting', false);
let hideReceipts = prefs.hideReceipts !== undefined ? Boolean(prefs.hideReceipts) : configBoolean('hideReceipts', false);
let avatarRadius = Number.isFinite(prefs.avatarRadius) ? clamp(prefs.avatarRadius,0,50) : configNumber('avatarRadius', 10, 0, 50);
let compactMode = prefs.compactMode !== undefined ? Boolean(prefs.compactMode) : configBoolean('compactMode', false);
let chatTheme = prefs.chatTheme !== undefined ? (prefs.chatTheme === 'light' ? 'light' : 'dark') : configChoice('theme', ['light','dark'], 'dark');
let sidebarPosition = prefs.sidebarPosition !== undefined ? (prefs.sidebarPosition === 'right' ? 'right' : 'left') : configChoice('sidebarPosition', ['left','right'], 'left');
let nameColour = validColour(prefs.nameColour) || validColour(roomConfig.nameColour) || DEFAULT_NAME_COLOUR;
let bubbleColour = validColour(prefs.bubbleColour) || validColour(roomConfig.bubbleColour) || DEFAULT_BUBBLE_COLOUR;
// The image is stored locally, never broadcast to peers. Use a small JPEG to
// keep localStorage usage predictable. Sample a downscaled canvas for colours.
let chatBackground = load('community-chat-background-v1', null);
if (!chatBackground || typeof chatBackground.image !== 'string' || !/^data:image\/jpeg;base64,/.test(chatBackground.image) || chatBackground.image.length > 1600000 || !Array.isArray(chatBackground.rgb)) chatBackground = null;
const backgroundWasCustomized = load('community-chat-background-choice-v1', false) === true;
const configuredBackgroundUrl = (() => { try { const url = new URL(roomConfig.backgroundUrl || '', document.baseURI); return ['http:', 'https:'].includes(url.protocol) && roomConfig.backgroundUrl ? url.href : null; } catch { return null; } })();
let gifBackgroundUrl = null;
const GIF_DB = 'community-chat-background-gif';
function gifStore(mode, task) {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(Error('This browser does not support GIF storage.')); return; }
    const request = indexedDB.open(GIF_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('images', mode);
      const query = task(transaction.objectStore('images'));
      query.onsuccess = () => resolve(query.result);
      query.onerror = () => reject(query.error);
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => reject(transaction.error);
    };
  });
}
function releaseGifUrl() { if (gifBackgroundUrl) URL.revokeObjectURL(gifBackgroundUrl); gifBackgroundUrl = null; }
async function restoreGifBackground() {
  try {
    const stored = await gifStore('readonly', store => store.get('current'));
    if (stored?.blob instanceof Blob && stored.blob.type === 'image/gif' && stored.blob.size <= 8 * 1024 * 1024) {
      releaseGifUrl(); gifBackgroundUrl = URL.createObjectURL(stored.blob);
      chatBackground = {image:gifBackgroundUrl, rgb:stored.rgb};
      applyPreferences();
    }
  } catch (error) { console.warn('[Community Chat] GIF background unavailable:',error); }
}
async function loadConfiguredBackground() {
  if (!configuredBackgroundUrl || backgroundWasCustomized || chatBackground) return;
  // A cross-origin image can still be displayed even if its host forbids canvas sampling.
  const fallback = chatTheme === 'light' ? [205,215,230] : [34,45,70];
  chatBackground = {image: configuredBackgroundUrl, rgb: fallback};
  applyBackground();
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (chatBackground?.image !== configuredBackgroundUrl) return;
    try {
      const canvas = document.createElement('canvas'); canvas.width=24; canvas.height=24;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img,0,0,24,24);
      const pixels = ctx.getImageData(0,0,24,24).data;
      let r=0,g=0,b=0,n=0;
      for (let i=0;i<pixels.length;i+=4) { if (pixels[i+3]<100) continue; r+=pixels[i];g+=pixels[i+1];b+=pixels[i+2];n++; }
      if (n) { chatBackground.rgb=[r/n,g/n,b/n]; applyBackground(); }
    } catch { /* CORS-blocked images still display with a theme-based palette. */ }
  };
  img.src=configuredBackgroundUrl;
}
let backgroundBlur = Number.isFinite(prefs.backgroundBlur) ? clamp(prefs.backgroundBlur,0,24) : configNumber('backgroundBlur', 0, 0, 24);
let backgroundOpacity = Number.isFinite(prefs.backgroundOpacity) ? clamp(prefs.backgroundOpacity,0,100) : configNumber('backgroundOpacity', 100, 0, 100);
const rgbCss = (rgb, a=1) => `rgba(${rgb.map(x=>Math.round(x)).join(',')},${a})`;
function backgroundPalette(rgb) {
  const luminance = (rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722)/255;
  const dark = luminance < .56;
  const blend=(a,b,t)=>a.map((v,i)=>Math.round(v*(1-t)+b[i]*t));
  const surface=blend(rgb,dark?[8,14,28]:[250,252,255],dark?.69:.79);
  const deep=blend(rgb,dark?[5,9,19]:[244,247,251],dark?.82:.89);
  const text=dark?'#f5f7ff':'#172335';
  const muted=dark?'#c0cde1':'#42516a';
  const control=blend(surface,dark?[45,58,82]:[218,227,239],.38);
  const bubble=blend(surface,dark?[52,68,96]:[215,225,240],.48);
  const root=$('chatWidget');
  root.style.setProperty('--bg-surface',rgbCss(surface));
  root.style.setProperty('--bg-deep',rgbCss(deep));
  root.style.setProperty('--bg-text',text);
  root.style.setProperty('--bg-muted',muted);
  root.style.setProperty('--bg-border',rgbCss(blend(surface,dark?[125,146,175]:[90,110,140],.27)));
  root.style.setProperty('--bg-control',rgbCss(control));
  root.style.setProperty('--bg-bubble',rgbCss(bubble,.95));
  root.style.setProperty('--bg-wash',dark?'rgba(3,8,18,.34)':'rgba(250,252,255,.34)');
}
function applyBackground() {
  const root=$('chatWidget');
  root.classList.toggle('has-chat-background',!!chatBackground);
  root.style.setProperty('--bg-blur',backgroundBlur+'px');
  root.style.setProperty('--bg-opacity',String(backgroundOpacity/100));
  $('backgroundBlur').value=String(backgroundBlur);
  $('backgroundBlurValue').textContent=backgroundBlur+'px';
  $('backgroundOpacity').value=String(backgroundOpacity);
  $('backgroundOpacityValue').textContent=backgroundOpacity+'%';
  $('chatBackgroundStatus').textContent=chatBackground?'Custom background active':'No custom background selected';
  if(chatBackground){
    root.style.setProperty('--bg-image',`url("${chatBackground.image}")`);
    backgroundPalette(chatBackground.rgb);
  } else root.style.removeProperty('--bg-image');
}
function prepareBackground(file) {
  if (!file.type.startsWith('image/') || file.size > 12*1024*1024) throw Error('Choose an image under 12 MB.');
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file), image=new Image();
    image.onload=()=>{
      URL.revokeObjectURL(url);
      try {
        const scale=Math.min(1,1280/image.width,900/image.height);
        const canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(image.width*scale));
        canvas.height=Math.max(1,Math.round(image.height*scale));
        const ctx=canvas.getContext('2d',{willReadFrequently:true});
        ctx.drawImage(image,0,0,canvas.width,canvas.height);
        const imageData=file.type==='image/gif' ? null : canvas.toDataURL('image/jpeg',.75);
        if(imageData && imageData.length>1600000) throw Error('Image is too complex to store. Try a smaller picture.');
        const sw=document.createElement('canvas');sw.width=24;sw.height=24;
        const sc=sw.getContext('2d',{willReadFrequently:true});sc.drawImage(image,0,0,24,24);
        const pixels=sc.getImageData(0,0,24,24).data;
        let r=0,g=0,b=0,n=0;
        for(let i=0;i<pixels.length;i+=4){if(pixels[i+3]<100)continue;r+=pixels[i];g+=pixels[i+1];b+=pixels[i+2];n++;}
        resolve({image:imageData,rgb:[r/n||30,g/n||40,b/n||60]});
      }catch(e){reject(e);}
    };
    image.onerror=()=>{URL.revokeObjectURL(url);reject(Error('Could not read this image.'));};
    image.src=url;
  });
}

function applyPreferences() {
  applyBackground();
  $('chatWidget').style.setProperty('--chat-scale', String(density / 100));
  $('densitySlider').value = String(density);
  $('densityValue').textContent = density + '%';
  $('hideTimestamps').checked = hideTimes;
  $('hideTyping').checked = hideTyping;
  $('hideImages').checked = hideImages;
  $('hideAvatars').checked = hideAvatars;
  $('avatarPreview').replaceChildren(makeAvatar(avatar, myName || 'You', false));
  $('hideReceipts').checked = hideReceipts;
  $('avatarRadiusSlider').value = String(avatarRadius);
  $('avatarRadiusValue').textContent = avatarRadius === 50 ? 'Circle' : avatarRadius === 0 ? 'Square' : `${avatarRadius}%`;
  $('chatWidget').style.setProperty('--avatar-radius', avatarRadius + '%');
  $('compactMode').checked = compactMode;
  $('chatWidget').classList.toggle('compact-mode', compactMode);
  $('chatTheme').value = chatTheme;
  $('sidebarPosition').value = sidebarPosition;
  $('chatWidget').dataset.theme = chatTheme;
  content.classList.toggle('sidebar-right', sidebarPosition === 'right');
  if (typeof setSidebarWidth === 'function') setSidebarWidth(sidebarWidth);
  $('advancedFormatting').checked = advancedFormatting;
  $('chatWidget').classList.toggle('advanced-formatting', advancedFormatting);
  refreshTypingIndicator();
  $('chatWidget').classList.toggle('hide-times', hideTimes);
  $('nameColour').value = nameColour; $('nameColourValue').textContent = nameColour;
  $('bubbleColour').value = bubbleColour; $('bubbleColourValue').textContent = bubbleColour;
  save('community-chat-preferences', {density, hideTimes, hideTyping, hideImages, hideAvatars, advancedFormatting, hideReceipts, chatTheme, sidebarPosition, nameColour, bubbleColour, avatarRadius, compactMode, backgroundBlur, backgroundOpacity});
}
applyPreferences();
$('chatBackgroundFile').addEventListener('change', async e => {
  const file=e.target.files?.[0]; if(!file)return;
  try {
    if (!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)) throw Error('Choose a JPEG, PNG, WebP or GIF.');
    if (file.type === 'image/gif' && file.size > 8 * 1024 * 1024) throw Error('GIF must be under 8 MB.');
    const result = await prepareBackground(file);
    if (file.type === 'image/gif') {
      // Preserve the original GIF bytes: canvas.toDataURL() would freeze its animation.
      await gifStore('readwrite', store => store.put({blob:file, rgb:result.rgb}, 'current'));
      releaseGifUrl(); gifBackgroundUrl = URL.createObjectURL(file);
      chatBackground = {image:gifBackgroundUrl, rgb:result.rgb};
      save('community-chat-background-v1',null);
    } else {
      save('community-chat-background-v1',result);
      if(load('community-chat-background-v1',null)?.image!==result.image) throw Error('Browser storage is full. Try a smaller picture.');
      await gifStore('readwrite',store=>store.delete('current')).catch(()=>{});
      releaseGifUrl(); chatBackground=result;
    }
    save('community-chat-background-choice-v1', true);
    applyPreferences();
  } catch(error){ alert(error.message||'Unable to use background image.'); }
  finally{e.target.value='';}
});
$('removeChatBackground').addEventListener('click',()=>{save('community-chat-background-choice-v1',true);chatBackground=null;releaseGifUrl();save('community-chat-background-v1',null);gifStore('readwrite',store=>store.delete('current')).catch(()=>{});applyPreferences();});
$('backgroundBlur').addEventListener('input',e=>{backgroundBlur=Number(e.target.value);applyPreferences();});
$('backgroundOpacity').addEventListener('input',e=>{backgroundOpacity=Number(e.target.value);applyPreferences();});
$('nameColour').addEventListener('input', async event => {
  nameColour = validColour(event.target.value) || DEFAULT_NAME_COLOUR;
  applyPreferences(); renderUsers();
  if (room && sendName) { try { await sendName({name: myName, nameColour, avatar}); } catch (e) { console.warn(e); } }
});
$('avatarFile').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    avatar = await prepareAvatar(file);
    save('community-chat-avatar', avatar);
    applyPreferences(); renderUsers(); renderMessages();
    await announceProfile();
  } catch (error) { alert(error.message || 'Could not load profile picture.'); }
  finally { event.target.value = ''; }
});
$('removeAvatar').addEventListener('click', async () => {
  avatar = null; save('community-chat-avatar', null);
  applyPreferences(); renderUsers(); renderMessages(); await announceProfile();
});
$('bubbleColour').addEventListener('input', event => { bubbleColour = validColour(event.target.value) || DEFAULT_BUBBLE_COLOUR; applyPreferences(); });
$('resetNameColour').addEventListener('click', () => { $('nameColour').value = DEFAULT_NAME_COLOUR; $('nameColour').dispatchEvent(new Event('input')); });
$('resetBubbleColour').addEventListener('click', () => { $('bubbleColour').value = DEFAULT_BUBBLE_COLOUR; $('bubbleColour').dispatchEvent(new Event('input')); });
$('densitySlider').addEventListener('input', e => { density = Number(e.target.value); applyPreferences(); });
$('hideTimestamps').addEventListener('change', e => { hideTimes = e.target.checked; applyPreferences(); });
$('hideTyping').addEventListener('change', e => { hideTyping = e.target.checked; applyPreferences(); });
$('chatTheme').addEventListener('change', e => { chatTheme = e.target.value === 'light' ? 'light' : 'dark'; applyPreferences(); });
$('sidebarPosition').addEventListener('change', e => { sidebarPosition = e.target.value === 'right' ? 'right' : 'left'; applyPreferences(); });
$('avatarRadiusSlider').addEventListener('input', e => { avatarRadius = Number(e.target.value); applyPreferences(); });
$('compactMode').addEventListener('change', e => { compactMode = e.target.checked; applyPreferences(); renderMessages(); });
$('hideReceipts').addEventListener('change', e => { hideReceipts = e.target.checked; applyPreferences(); renderMessages(); });
$('hideAvatars').addEventListener('change', e => { hideAvatars = e.target.checked; applyPreferences(); renderMessages(); });
$('hideImages').addEventListener('change', e => { hideImages = e.target.checked; applyPreferences(); renderMessages(); });
$('advancedFormatting').addEventListener('change', e => { advancedFormatting = e.target.checked; applyPreferences(); });
function setSettings(open) {
  $('settingsScreen').hidden = !open;
  $('settingsToggle').setAttribute('aria-expanded', String(open));
  if (open) $('settingsName').value = myName || $('username').value;
  else markConversationSeen();
}
$('settingsToggle').addEventListener('click', () => setSettings($('settingsScreen').hidden));
$('settingsClose').addEventListener('click', () => setSettings(false));
$('saveName').addEventListener('click', async () => {
  const name = $('settingsName').value.trim().slice(0, 24);
  if (!name) { $('settingsName').focus(); return; }
  const previous = myName;
  myName = name; $('username').value = name; renderUsers();
  if (room && previous !== name) {
    addSystem(`You changed your name to ${name}.`);
    try { await sendName({name, nameColour, avatar}); }
    catch (error) { console.warn('Could not announce name change:', error); }
  }
  setSettings(false);
});

// ===== Resize the floating window and user pane =====
const SIZE_KEY = 'community-chat-size';
const SIDEBAR_KEY = 'community-chat-sidebar-width';
const COLLAPSED_KEY = 'community-chat-users-collapsed';
function setWidgetSize(width, height) {
  const maxW = Math.max(100, innerWidth - 20);
  const maxH = Math.max(100, innerHeight - 20);
  panel.style.width = clamp(width, Math.min(280, maxW), maxW) + 'px';
  panel.style.height = clamp(height, Math.min(240, maxH), maxH) + 'px';
}
const savedSize = load(SIZE_KEY, null);
if (savedSize && Number.isFinite(savedSize.width) && Number.isFinite(savedSize.height))
  setWidgetSize(savedSize.width, savedSize.height);
else setWidgetSize(configNumber('widgetWidth', 440, 280, 1200), configNumber('widgetHeight', 500, 240, 1000));

function attachDrag(handle, className, onMove, onEnd) {
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX, startY = event.clientY;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add(className);
    const move = e => onMove(e.clientX - startX, e.clientY - startY);
    const finish = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      document.body.classList.remove(className);
      onEnd?.();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  });
}
let resizeStartWidth = 390, resizeStartHeight = 500;
$('chatResize').addEventListener('pointerdown', () => {
  resizeStartWidth = panel.offsetWidth;
  resizeStartHeight = panel.offsetHeight;
}, {capture: true});
attachDrag($('chatResize'), 'chat-resizing', (dx, dy) => {
  setWidgetSize(resizeStartWidth - dx, resizeStartHeight - dy);
  setSidebarWidth(sidebarWidth);
}, () => save(SIZE_KEY, {width: panel.offsetWidth, height: panel.offsetHeight}));

sidebarWidth = load(SIDEBAR_KEY, configNumber('sidebarWidth', 130, 65, 500));
if (!Number.isFinite(sidebarWidth)) sidebarWidth = configNumber('sidebarWidth', 130, 65, 500);
function setSidebarWidth(width) {
  // Keep the requested width even while the widget is hidden or the viewport is narrow.
  // Only clamp the rendered width, so opening/resizing doesn't erase the saved preference.
  sidebarWidth = clamp(width, 65, 500);
  const available = content.clientWidth || panel.clientWidth || 390;
  const displayedWidth = clamp(sidebarWidth, 65, Math.max(65, available - 155));
  if (!content.classList.contains('users-collapsed'))
    content.style.gridTemplateColumns = sidebarPosition === 'right' ? `minmax(0, 1fr) 5px ${displayedWidth}px` : `${displayedWidth}px 5px minmax(0, 1fr)`;
}
let sidebarStartWidth = sidebarWidth;
$('sidebarResize').addEventListener('pointerdown', () => { sidebarStartWidth = sidebarWidth; }, {capture: true});
attachDrag($('sidebarResize'), 'sidebar-resizing', dx => setSidebarWidth(sidebarStartWidth + (sidebarPosition === 'right' ? -dx : dx)),
  () => save(SIDEBAR_KEY, sidebarWidth));
$('sidebarResize').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  setSidebarWidth(sidebarWidth + (event.key === 'ArrowRight' ? 10 : -10) * (sidebarPosition === 'right' ? -1 : 1));
  save(SIDEBAR_KEY, sidebarWidth);
});
function setUsersCollapsed(collapsed) {
  content.classList.toggle('users-collapsed', collapsed);
  $('usersToggle').setAttribute('aria-expanded', String(!collapsed));
  $('usersToggle').setAttribute('aria-label', collapsed ? 'Show online users' : 'Hide online users');
  if (collapsed) content.style.gridTemplateColumns = 'minmax(0, 1fr)';
  else setSidebarWidth(sidebarWidth);
  save(COLLAPSED_KEY, collapsed);
}
$('usersToggle').addEventListener('click', () => setUsersCollapsed(!content.classList.contains('users-collapsed')));
setUsersCollapsed(load(COLLAPSED_KEY, false));
setSidebarWidth(sidebarWidth);
window.addEventListener('resize', () => {
  setWidgetSize(panel.offsetWidth, panel.offsetHeight);
  setSidebarWidth(sidebarWidth);
});
window.addEventListener('pagehide', () => { if (room) { try { room.leave(); } catch {} } });
setChatOpen(false);

restoreGifBackground().then(() => loadConfiguredBackground());
