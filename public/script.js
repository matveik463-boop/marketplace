const App = {
  getToken: () => localStorage.getItem('token'),
  getUser: () => JSON.parse(localStorage.getItem('user') || 'null'),
  isFavorite: (listingId) => {
    const favs = JSON.parse(localStorage.getItem('favs') || '[]');
    return favs.includes(listingId);
  },
  toggleFavorite: async (listingId) => {
    const token = App.getToken();
    if (!token) { alert('Войдите в систему'); return; }
    if (App.isFavorite(listingId)) {
      await fetch(`/api/favorites/${listingId}`, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } });
      App.removeFavLocal(listingId);
    } else {
      await fetch(`/api/favorites/${listingId}`, { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
      App.addFavLocal(listingId);
    }
    window.location.reload();
  },
  addFavLocal: (id) => {
    const favs = JSON.parse(localStorage.getItem('favs') || '[]');
    if (!favs.includes(id)) { favs.push(id); localStorage.setItem('favs', JSON.stringify(favs)); }
  },
  removeFavLocal: (id) => {
    let favs = JSON.parse(localStorage.getItem('favs') || '[]');
    favs = favs.filter(f => f !== id);
    localStorage.setItem('favs', JSON.stringify(favs));
  },

  makePurchase: async (listingId) => {
    const token = App.getToken();
    if (!token) return { error: 'Войдите в систему' };
    const res = await fetch('/api/escrow/buy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ listingId })
    });
    return await res.json();
  },

  // WebSocket и уведомления
  socket: null,
  notifications: [],
  initSocket: () => {
    if (typeof io === 'undefined') return;
    const token = App.getToken();
    if (!token) return;
    if (App.socket) App.socket.disconnect();
    App.socket = io('/', { auth: { token } });

    App.socket.on('notification', (data) => {
      App.notifications.push(data);
      App.updateNotificationBell();
    });

    App.socket.on('connect', () => {
      console.log('Global socket connected');
    });
  },

  updateNotificationBell: () => {
    const bell = document.getElementById('notification-bell');
    const countSpan = document.getElementById('notification-count');
    if (!bell || !countSpan) return;
    const user = App.getUser();
    if (!user) { bell.style.display = 'none'; return; }
    bell.style.display = 'inline-block';
    const count = App.notifications.length;
    countSpan.textContent = count;
    countSpan.style.display = count > 0 ? 'inline' : 'none';

    bell.onclick = () => {
      if (App.notifications.length === 0) {
        alert('Нет новых уведомлений');
        return;
      }
      const messages = App.notifications.map(n => n.message).join('\n\n');
      alert('Уведомления:\n\n' + messages);
      App.notifications = [];
      App.updateNotificationBell();
    };
  },

  loadNotificationsFromServer: async () => {
    const token = App.getToken();
    if (!token) return;
    try {
      const res = await fetch('/api/notifications', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      const notifications = await res.json();
      const unread = notifications.filter(n => n.read === 0);
      if (unread.length > 0) {
        unread.forEach(n => App.notifications.push({ message: n.message, type: n.type }));
        App.updateNotificationBell();
        await fetch('/api/notifications/read', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token }
        });
      }
    } catch (err) {
      console.error('Ошибка загрузки уведомлений:', err);
    }
  },

  // ---------- ТЕМА ----------
  theme: localStorage.getItem('theme') || 'light',

  applyTheme: () => {
    if (App.theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  },

  toggleTheme: () => {
    const overlay = document.createElement('div');
    overlay.id = 'theme-overlay';
    document.body.appendChild(overlay);

    const circle = document.createElement('div');
    circle.className = 'overlay-circle';

    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const maxRadius = Math.sqrt(centerX ** 2 + centerY ** 2);

    if (App.theme === 'light') {
      circle.style.width = `${maxRadius * 2}px`;
      circle.style.height = `${maxRadius * 2}px`;
      circle.style.left = `${centerX - maxRadius}px`;
      circle.style.top = `${centerY - maxRadius}px`;
      circle.classList.add('collapsing');
      overlay.appendChild(circle);

      requestAnimationFrame(() => {
        circle.style.transform = 'scale(1)';
      });

      setTimeout(() => {
        document.documentElement.classList.add('dark');
        App.theme = 'dark';
        localStorage.setItem('theme', 'dark');
        overlay.remove();
      }, 500);
    } else {
      circle.style.width = '0px';
      circle.style.height = '0px';
      circle.style.left = `${centerX}px`;
      circle.style.top = `${centerY}px`;
      circle.classList.add('expanding');
      overlay.appendChild(circle);

      requestAnimationFrame(() => {
        circle.style.width = `${maxRadius * 2}px`;
        circle.style.height = `${maxRadius * 2}px`;
        circle.style.left = `${centerX - maxRadius}px`;
        circle.style.top = `${centerY - maxRadius}px`;
        circle.style.transform = 'scale(1)';
      });

      setTimeout(() => {
        document.documentElement.classList.remove('dark');
        App.theme = 'light';
        localStorage.setItem('theme', 'light');
        overlay.remove();
      }, 500);
    }
  },

  // ---------- Мобильная навигация ----------
  initMobileNav: () => {
    const nav = document.querySelector('.glass-nav');
    if (!nav) return;
    const links = nav.querySelectorAll('a[data-page]');
    const glider = nav.querySelector('.glass-glider');
    const currentPath = window.location.pathname.split('/').pop() || 'index.html';

    links.forEach((link, index) => {
      const page = link.getAttribute('data-page');
      if ((page === 'home' && (currentPath === 'index.html' || currentPath === '')) ||
          (page === 'create' && currentPath === 'create-listing.html') ||
          (page === 'wallet' && currentPath === 'wallet.html') ||
          (page === 'profile' && currentPath === 'profile.html')) {
        link.classList.add('active');
        if (glider) {
          glider.style.transform = `translateX(${index * 100}%)`;
        }
      } else {
        link.classList.remove('active');
      }
    });
  },

  init: () => {
    const user = App.getUser();
    const loginLink = document.getElementById('login-link');
    const registerLink = document.getElementById('register-link');
    const userNameSpan = document.getElementById('user-name');
    const logoutBtn = document.getElementById('logout-btn');
    if (user) {
      if (loginLink) loginLink.style.display = 'none';
      if (registerLink) registerLink.style.display = 'none';
      if (userNameSpan) { userNameSpan.style.display = 'inline'; userNameSpan.textContent = user.name; }
      if (logoutBtn) {
        logoutBtn.style.display = 'inline';
        logoutBtn.addEventListener('click', () => {
          if (App.socket) App.socket.disconnect();
          localStorage.clear();
          window.location.reload();
        });
      }
      App.loadNotificationsFromServer();
    }
    App.applyTheme();

    App.updateNotificationBell();
    if (typeof io !== 'undefined') {
      App.initSocket();
    }
  },

  loadListings: async (page = 1) => {
    const search = document.getElementById('search-input')?.value || '';
    const category = document.getElementById('category-select')?.value || 'all';
    const minPrice = document.getElementById('min-price')?.value || '';
    const maxPrice = document.getElementById('max-price')?.value || '';
    const params = new URLSearchParams({ page, limit: 12, search, category, minPrice, maxPrice });
    try {
      const res = await fetch('/api/listings?' + params);
      const data = await res.json();
      const container = document.getElementById('listings-container');
      if (!container) return;
      container.innerHTML = data.listings.map(l => `
        <div class="card listing-card">
          ${l.images && l.images.length ? `<img src="${JSON.parse(l.images)[0]}" alt="${l.title}" class="w-full h-48 object-cover rounded-lg">` : ''}
          <div class="p-4">
            <h3 class="text-lg font-semibold"><a href="listing.html?id=${l.id}" class="text-indigo-600 hover:underline">${l.title}</a></h3>
            <p class="text-gray-700 font-medium mt-2"><strong>${l.price} ₽</strong></p>
            <p class="text-gray-500 text-sm">${l.sellerName}</p>
            <button class="fav-btn mt-2 text-sm" data-id="${l.id}">${App.isFavorite(l.id) ? '❌' : '⭐'}</button>
          </div>
        </div>
      `).join('');
      document.querySelectorAll('.fav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          App.toggleFavorite(btn.dataset.id);
        });
      });
      const pagDiv = document.getElementById('pagination');
      if (pagDiv) {
        let html = '';
        for (let i = 1; i <= data.totalPages; i++) {
          html += `<button class="px-3 py-1 rounded ${i === data.page ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-700'} hover:bg-indigo-500 hover:text-white transition">${i}</button>`;
        }
        pagDiv.innerHTML = html;
      }
    } catch (err) {
      console.error('Ошибка загрузки объявлений:', err);
    }
  }
};

// Глобальные обработчики
document.addEventListener('DOMContentLoaded', () => {
  if (App.getUser()) {
    App.init();
    App.updateNotificationBell();
  }
  App.loadListings();

  // Кнопка темы (если есть)
  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => App.toggleTheme());
  }

  // Инициализация мобильной навигации (везде, где есть .glass-nav)
  App.initMobileNav();
});

// Ripple-эффект для всех кнопок
document.addEventListener('click', function(e) {
  const target = e.target.closest('button');
  if (!target) return;

  const ripple = document.createElement('span');
  ripple.className = 'ripple';
  const rect = target.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  ripple.style.width = ripple.style.height = size + 'px';
  ripple.style.left = (e.clientX - rect.left - size/2) + 'px';
  ripple.style.top = (e.clientY - rect.top - size/2) + 'px';
  target.appendChild(ripple);

  ripple.addEventListener('animationend', () => {
    ripple.remove();
  });
});