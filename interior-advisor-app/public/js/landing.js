const menuButton = document.querySelector('.landing-menu-toggle');
const navigationMenu = document.getElementById('landingMenu');

if (menuButton && navigationMenu) {
  function setMenuOpen(open, returnFocus = false) {
    navigationMenu.hidden = !open;
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
    menuButton.title = open ? 'Close menu' : 'Open menu';

    if (returnFocus) menuButton.focus();
  }

  menuButton.addEventListener('click', () => {
    setMenuOpen(navigationMenu.hidden);
  });

  navigationMenu.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a')) {
      setMenuOpen(false);
    }
  });

  document.addEventListener('click', (event) => {
    if (!menuButton.contains(event.target) && !navigationMenu.contains(event.target)) {
      setMenuOpen(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !navigationMenu.hidden) {
      setMenuOpen(false, true);
    }
  });
}