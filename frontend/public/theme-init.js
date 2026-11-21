try {
  var t = localStorage.getItem('theme') || 'system';
  if (t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
  document.documentElement.lang = localStorage.getItem('locale') || 'en';
} catch (e) {}
