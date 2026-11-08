// Vanilla bench site — plain DOM behavior, no framework, no backend.
// Every interaction produces visible, assertable text.

function show(el, cls, text) {
  el.textContent = text;
  el.className = 'status ' + cls;
}

// pricing.html — choosing a plan reports which plan was chosen.
document.querySelectorAll('[data-plan]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var status = document.getElementById('plan-status');
    show(status, 'ok', 'You selected the ' + btn.getAttribute('data-plan') + ' plan.');
  });
});

// contact.html — all fields required; success resets the form.
var contactForm = document.getElementById('contact-form');
if (contactForm) {
  contactForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var status = document.getElementById('contact-status');
    var name = document.getElementById('contact-name').value.trim();
    var email = document.getElementById('contact-email').value.trim();
    var message = document.getElementById('contact-message').value.trim();
    if (!name || !email || !message) {
      show(status, 'err', 'Please fill in every field.');
      return;
    }
    show(status, 'ok', 'Thanks, we got your message.');
    contactForm.reset();
  });
}

// login.html — demo credentials only; both outcomes are visible text.
var loginForm = document.getElementById('login-form');
if (loginForm) {
  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var status = document.getElementById('login-status');
    var user = document.getElementById('login-username').value.trim();
    var pass = document.getElementById('login-password').value;
    if (user === 'demo' && pass === 'demo123') {
      show(status, 'ok', 'Welcome back, demo!');
    } else {
      show(status, 'err', 'Invalid username or password.');
    }
  });
}
