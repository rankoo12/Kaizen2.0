// Vanilla bench site, v2 — behavior identical to v1, wired to the renamed ids.
// The churn is the mutation under test; the FEATURES did not change.

function show(el, cls, text) {
  el.textContent = text;
  el.className = 'status ' + cls;
}

// pricing.html — untouched from v1.
document.querySelectorAll('[data-plan]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var status = document.getElementById('plan-status');
    show(status, 'ok', 'You selected the ' + btn.getAttribute('data-plan') + ' plan.');
  });
});

// contact.html — renamed ids, same outcome text.
var contactForm = document.getElementById('form-contact');
if (contactForm) {
  contactForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var status = document.getElementById('form-status');
    var name = document.getElementById('f-name').value.trim();
    var email = document.getElementById('f-email').value.trim();
    var message = document.getElementById('f-message').value.trim();
    if (!name || !email || !message) {
      show(status, 'err', 'Please fill in every field.');
      return;
    }
    show(status, 'ok', 'Thanks, we got your message.');
    contactForm.reset();
  });
}

// login.html — renamed ids, same outcome text.
var loginForm = document.getElementById('form-signin');
if (loginForm) {
  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var status = document.getElementById('signin-status');
    var user = document.getElementById('input-user').value.trim();
    var pass = document.getElementById('input-pass').value;
    if (user === 'demo' && pass === 'demo123') {
      show(status, 'ok', 'Welcome back, demo!');
    } else {
      show(status, 'err', 'Invalid username or password.');
    }
  });
}
