/**
 * Logix — Theme (professional)
 * Applies saved theme before first paint and exposes toggle API.
 */
(function () {
    const KEY = 'logix-theme';

    function apply(theme) {
        document.documentElement.setAttribute('data-theme', theme);
    }

    const saved = localStorage.getItem(KEY) || 'light';
    apply(saved);
})();
