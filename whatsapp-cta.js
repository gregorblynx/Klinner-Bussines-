(() => {
  const id = 'klinner-whatsapp-cta';
  if (document.getElementById(id)) return;

  const link = document.createElement('a');
  link.id = id;
  link.href = 'https://wa.me/16156694072?text=Hi%20Klinner%2C%20I%27d%20like%20a%20cleaning%20quote.';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = 'Chat on WhatsApp';
  link.setAttribute('aria-label', 'Chat with Klinner on WhatsApp');
  link.innerHTML = '<svg aria-hidden="true" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.4"><path d="M27.3 15.2a11.1 11.1 0 0 1-16.4 9.8L5 27l1.9-5.4A11.1 11.1 0 1 1 27.3 15.2Z"/><path d="M12.2 10.3c.3-.7.7-.6 1.1-.6h.7c.2 0 .5.1.6.5l1 2.3c.1.3.1.5 0 .7l-.7.8c-.2.2-.3.4-.1.7.6 1 1.5 1.9 2.5 2.5.3.2.5.1.7-.1l.8-.9c.2-.2.4-.3.7-.1l2.3 1.1c.4.2.4.5.4.7 0 .7-.4 1.6-1 2-.4.3-1 .5-1.7.4-1.1-.2-3.2-1.2-5.2-3.1-1.8-1.8-2.8-3.9-3-5.1-.1-.7.1-1.3.4-1.7Z"/></svg><span>WhatsApp</span>';

  const style = document.createElement('style');
  style.textContent = `
    #${id} {
      align-items: center; background: #2ABFBF; border-radius: 50%; bottom: 24px;
      box-shadow: 0 8px 22px rgba(42, 191, 191, .35); color: #fff; display: inline-flex;
      height: 52px; justify-content: center; left: 24px; position: fixed;
      text-decoration: none; width: 52px; z-index: 1001;
    }
    #${id}:hover, #${id}:focus-visible { background: #1a9e9e; color: #fff; transform: translateY(-2px); }
    #${id}:focus-visible { outline: 3px solid #173f5f; outline-offset: 3px; }
    #${id} svg { height: 21px; width: 21px; }
    #${id} span { position: absolute; clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px; overflow: hidden; white-space: nowrap; width: 1px; }
    @media (max-width: 640px) {
      #${id} { bottom: 16px; height: 48px; left: 16px; width: 48px; }
    }
  `;

  document.head.append(style);
  document.body.append(link);
})();
