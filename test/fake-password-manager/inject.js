// Stands in for a password manager extension: on a page with a password field, it adds its own frame
// (its autofill menu), as 1Password or Bitwarden do on sites they hold a login for.
setTimeout(() => {
  if (!document.querySelector('input[type=password]')) return;
  const menu = document.createElement('iframe');
  menu.src = chrome.runtime.getURL('menu.html');
  menu.style.cssText = 'position:fixed;top:0;left:0;width:100px;height:40px;border:0';
  document.body.append(menu);
}, 1000);
