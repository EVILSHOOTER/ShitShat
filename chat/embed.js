/* Embed with <script src="/chat/embed.js" defer></script>. */
(() => {
  if (document.getElementById('chatWidget') || window.__communityChatEmbedding) return;
  window.__communityChatEmbedding = true;
  const embedTag = document.currentScript;
  const base = new URL('.', embedTag.src);
  const appId = embedTag.getAttribute('data-app-id');
  const roomId = embedTag.getAttribute('data-room-id');
  // Forward only documented, optional settings; chat.js validates each value.
  const settings = ['backgroundUrl','backgroundBlur','backgroundOpacity','theme',
    'sidebarWidth','sidebarPosition','compactMode','density','avatarRadius',
    'hideImages','hideAvatars','hideTyping','hideReceipts','hideTimestamps',
    'advancedFormatting','nameColour','bubbleColour','widgetWidth','widgetHeight',
    'historyLimit','awayMinutes','longMessageChars','longMessageLines'];
  async function mount() {
    try {
      const response = await fetch(new URL('widget.html', base));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (document.getElementById('chatWidget')) return;
      const style = document.createElement('link');
      style.rel = 'stylesheet';
      style.href = new URL('chat.css', base).href;
      document.head.append(style);
      await new Promise(resolve => { style.addEventListener("load", resolve, {once:true}); style.addEventListener("error", resolve, {once:true}); });
      const host = document.createElement('div');
      host.innerHTML = html;
      const widget = host.querySelector('#chatWidget');
      if (!widget) throw new Error('Missing chatWidget in widget.html');
      if (appId) widget.dataset.appId = appId;
      if (roomId) widget.dataset.roomId = roomId;
      for (const key of settings) { if (embedTag.dataset[key] !== undefined) widget.dataset[key] = embedTag.dataset[key]; }
      document.body.append(widget);
      const script = document.createElement('script');
      script.type = 'module';
      script.src = new URL('chat.js', base).href;
      document.body.append(script);
    } catch (error) {
      console.error('[Community Chat] Unable to load widget:', error);
      window.__communityChatEmbedding = false;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
