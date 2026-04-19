-- Seed: Element Archetype Library
-- Spec ref: Smart Brain Layer 0 — spec-smart-brain-layer0.md
--
-- Pre-seeded archetypes for universal UI element patterns.
-- Idempotent — safe to run multiple times (ON CONFLICT DO NOTHING).
--
-- name_patterns values are normalised: lowercase, trimmed, internal whitespace collapsed.
-- The resolver normalises the candidate accessible name before comparison.

INSERT INTO element_archetypes (name, role, name_patterns, action_hint, confidence)
VALUES

-- ── Authentication ───────────────────────────────────────────────────────────
('login_button',   'button',   ARRAY['login', 'log in', 'log into', 'sign in', 'sign into', 'sign in with email', 'sign in with google', 'sign in with github', 'sign in with microsoft', 'sign in with apple', 'log in with email', 'log in with google', 'continue with email', 'continue with google', 'continue with github', 'log me in', 'sign me in', 'authenticate', 'enter system', 'access account', 'login to your account', 'sign in to your account'], 'click', 0.95),
('logout_button',  'button',   ARRAY['log out', 'logout', 'sign out', 'signout', 'log off', 'logoff', 'exit', 'exit account', 'end session', 'disconnect'], 'click', 0.95),
('signup_button',  'button',   ARRAY['sign up', 'signup', 'create account', 'register', 'get started', 'join', 'join now', 'create free account', 'start free trial', 'register now', 'create a new account', 'sign up free', 'join us', 'become a member', 'enroll'], 'click', 0.95),

-- ── Form fields ──────────────────────────────────────────────────────────────
('email_input',    'textbox',  ARRAY['email', 'email address', 'e-mail', 'e-mail address', 'work email', 'username or email', 'email or username', 'email / username', 'enter your email address', 'enter email address', 'your email address', 'enter your email', 'type your email', 'e-mail id', 'mail', 'contact email', 'personal email'], 'type', 0.95),
('password_input', 'textbox',  ARRAY['password', 'current password', 'enter password', 'your password', 'passcode', 'secret', 'pass', 'type your password', 'pword', 'pwd'], 'type', 0.95),
('search_input',   'searchbox', ARRAY['search', 'search...', 'search for anything', 'what are you looking for', 'search*', 'find', 'find...', 'search here', 'type to search', 'query'], 'type', 0.95),
('search_input_textbox', 'textbox', ARRAY['search', 'search...', 'search*', 'find', 'find...', 'search here', 'type to search', 'query'], 'type', 0.92),
('search_input_combobox', 'combobox', ARRAY['search', 'search...', 'search*', 'find', 'find...', 'search here', 'type to search', 'query'], 'type', 0.92),

-- ── Navigation ───────────────────────────────────────────────────────────────
('submit_button',  'button',   ARRAY['submit', 'continue', 'next', 'confirm', 'save', 'save changes', 'apply', 'done', 'update', 'finish', 'proceed', 'go', 'save & continue', 'commit', 'validate', 'accept'], 'click', 0.90),
('home_link',      'link',     ARRAY['home', 'go to home', 'homepage', 'back to home', 'main page', 'start page', 'front page', 'return to home', 'home page'], 'click', 0.95),
('about_link',     'link',     ARRAY['about', 'about us', 'our story', 'who we are', 'company', 'about the company', 'get to know us', 'learn more about us', 'company info'], 'click', 0.95),
('contact_link',   'link',     ARRAY['contact', 'contact us', 'get in touch', 'contact support', 'reach out', 'write to us', 'message us', 'connect with us', 'need help?', 'customer service'], 'click', 0.95),
('dashboard_link', 'link',     ARRAY['dashboard', 'my dashboard', 'overview', 'control panel', 'hub', 'home dashboard', 'main dashboard', 'user dashboard', 'admin panel'], 'click', 0.95),
('settings_link',  'link',     ARRAY['settings', 'preferences', 'account settings', 'options', 'configuration', 'config', 'user settings', 'app settings', 'advanced settings', 'my settings'], 'click', 0.95),
('profile_link',   'link',     ARRAY['profile', 'my profile', 'view profile', 'edit profile', 'account profile', 'user profile', 'your profile', 'manage profile', 'personal details'], 'click', 0.95),
('faq_link',       'link',     ARRAY['faq', 'frequently asked questions', 'help & faq', 'q&a', 'questions and answers', 'common questions'], 'click', 0.95),
('help_link',      'link',     ARRAY['help', 'help center', 'support', 'customer support', 'need assistance', 'get help', 'support center', 'help desk'], 'click', 0.95),
('terms_link',     'link',     ARRAY['terms', 'terms of service', 'terms and conditions', 'tos', 'terms of use', 'legal terms', 'user agreement', 'service agreement'], 'click', 0.95),
('privacy_link',   'link',     ARRAY['privacy', 'privacy policy', 'privacy notice', 'data privacy', 'data protection', 'privacy & cookies'], 'click', 0.95),
('cart_nav_link',  'link',     ARRAY['cart', 'shopping cart', 'my cart', 'basket', 'shopping basket', 'my basket', 'view cart', 'go to basket'], 'click', 0.95),
('checkout_link',  'link',     ARRAY['checkout', 'proceed to checkout', 'go to checkout', 'secure checkout', 'pay now', 'checkout now'], 'click', 0.95),

-- ── Form elements Extended ───────────────────────────────────────────────────
('first_name_input', 'textbox', ARRAY['first name', 'given name', 'fname', 'first', 'forename'], 'type', 0.95),
('last_name_input',  'textbox', ARRAY['last name', 'family name', 'surname', 'lname', 'last'], 'type', 0.95),
('full_name_input',  'textbox', ARRAY['full name', 'name', 'your name', 'complete name', 'display name'], 'type', 0.92),
('phone_input',      'textbox', ARRAY['phone', 'phone number', 'mobile', 'cell phone', 'telephone', 'mobile number', 'cell', 'contact number', 'tel'], 'type', 0.95),
('address_input',    'textbox', ARRAY['address', 'street address', 'address line 1', 'street', 'mailing address', 'shipping address', 'billing address'], 'type', 0.95),
('city_input',       'textbox', ARRAY['city', 'town', 'municipality', 'locality'], 'type', 0.95),
('state_input',      'textbox', ARRAY['state', 'province', 'region', 'state/province', 'territory', 'county'], 'type', 0.95),
('zip_input',        'textbox', ARRAY['zip', 'zip code', 'postal code', 'postcode', 'pin code', 'zip/postal code'], 'type', 0.95),
('country_input',    'combobox', ARRAY['country', 'country/region', 'nation', 'country of residence'], 'type', 0.95),
('dob_input',        'textbox', ARRAY['date of birth', 'dob', 'birth date', 'birthday', 'date of birth (optional)'], 'type', 0.95),
('company_input',    'textbox', ARRAY['company', 'company name', 'organization', 'employer', 'workplace', 'business name'], 'type', 0.95),
('job_title_input',  'textbox', ARRAY['job title', 'title', 'role', 'position', 'profession', 'occupation'], 'type', 0.95),

-- ── E-commerce ───────────────────────────────────────────────────────────────
('add_to_cart_btn',  'button',  ARRAY['add to cart', 'add to bag', 'add to basket', 'buy', 'add', 'put in cart', 'put in basket', 'add item'], 'click', 0.95),
('buy_now_button',   'button',  ARRAY['buy now', 'purchase', 'buy it now', 'checkout now', 'buy this', 'secure purchase', 'order now'], 'click', 0.95),
('quantity_input',   'spinbutton', ARRAY['quantity', 'qty', 'amount', 'number of items', 'count'], 'type', 0.95),
('size_selector',    'combobox', ARRAY['size', 'choose size', 'select size', 'pick a size', 'clothing size', 'shoe size'], 'click', 0.95),
('color_selector',   'combobox', ARRAY['color', 'colour', 'choose color', 'select color', 'pick a color', 'shade'], 'click', 0.95),
('promo_code_input', 'textbox', ARRAY['promo code', 'discount code', 'gift card', 'coupon code', 'voucher code', 'enter promo code', 'offer code', 'promotional code'], 'type', 0.95),
('apply_promo_btn',  'button',  ARRAY['apply', 'apply code', 'apply promo', 'redeem', 'apply discount', 'use code'], 'click', 0.95),

-- ── Social ───────────────────────────────────────────────────────────────────
('like_button',      'button',  ARRAY['like', 'thumbs up', 'love', 'favorite', 'heart', 'upvote'], 'click', 0.95),
('share_button',     'button',  ARRAY['share', 'share this', 'send', 'share post', 'share article', 'forward'], 'click', 0.95),
('comment_button',   'button',  ARRAY['comment', 'add comment', 'reply', 'leave a comment', 'write a comment', 'respond'], 'click', 0.95),
('follow_button',    'button',  ARRAY['follow', 'follow user', 'follow page', 'subscribe to user'], 'click', 0.95),
('subscribe_button', 'button',  ARRAY['subscribe', 'subscribe now', 'join', 'opt in', 'subscribe to channel'], 'click', 0.95),
('retweet_button',   'button',  ARRAY['retweet', 'repost', 'share post', 'quote tweet'], 'click', 0.95),

-- ── Media ────────────────────────────────────────────────────────────────────
('play_button',      'button',  ARRAY['play', 'play video', 'play audio', 'start playback', 'resume', 'start video'], 'click', 0.95),
('pause_button',     'button',  ARRAY['pause', 'pause video', 'pause audio', 'suspend', 'stop playback temporarily'], 'click', 0.95),
('stop_button',      'button',  ARRAY['stop', 'stop video', 'stop audio', 'end playback', 'halt'], 'click', 0.95),
('volume_slider',    'slider',  ARRAY['volume', 'adjust volume', 'sound level', 'volume control'], 'type', 0.90),
('mute_button',      'button',  ARRAY['mute', 'unmute', 'toggle mute', 'turn off sound', 'silence'], 'click', 0.95),
('fullscreen_button','button',  ARRAY['fullscreen', 'full screen', 'enter fullscreen', 'exit fullscreen', 'maximize video', 'expand'], 'click', 0.95),
('next_track_btn',   'button',  ARRAY['next track', 'skip', 'skip track', 'next video', 'next song', 'forward', 'skip to next'], 'click', 0.95),
('prev_track_btn',   'button',  ARRAY['previous track', 'prev track', 'previous video', 'previous song', 'go back', 'backward'], 'click', 0.95),

-- ── Table operations ─────────────────────────────────────────────────────────
('sort_button',      'button',  ARRAY['sort', 'sort by', 'order by', 'arrange by', 'sorting options'], 'click', 0.95),
('filter_button',    'button',  ARRAY['filter', 'filters', 'filter by', 'refine', 'refine by', 'search filters'], 'click', 0.95),
('pagination_next',  'button',  ARRAY['next page', 'next', 'forward', '>', 'show more', 'load more', 'next results'], 'click', 0.95),
('pagination_prev',  'button',  ARRAY['previous page', 'previous', 'prev', 'back', '<', 'previous results'], 'click', 0.95),
('items_per_page',   'combobox', ARRAY['items per page', 'rows per page', 'show per page', 'results per page', 'displays per page'], 'click', 0.90),

-- ── Modal/dialog ─────────────────────────────────────────────────────────────
('close_button',     'button',  ARRAY['close', 'x', 'dismiss', 'close dialog', 'close modal', 'shut', 'hide'], 'click', 0.95),
('cancel_button',    'button',  ARRAY['cancel', 'discard', 'nevermind', 'go back', 'abort', 'ignore'], 'click', 0.95),
('confirm_button',   'button',  ARRAY['confirm', 'yes', 'agree', 'ok', 'okay', 'accept', 'sure', 'i agree'], 'click', 0.95),

-- ── Common ARIA patterns ─────────────────────────────────────────────────────
('tab_element',      'tab',       ARRAY['tab', 'tab heading', 'tab item'], 'click', 0.90),
('tabpanel_element', 'tabpanel',  ARRAY['tab panel', 'tab content', 'panel content'], 'click', 0.85),
('menu_element',     'menu',      ARRAY['menu', 'options menu', 'context menu', 'dropdown menu', 'popup menu'], 'click', 0.90),
('menuitem_element', 'menuitem',  ARRAY['menu item', 'option', 'dropdown item', 'choice'], 'click', 0.90),
('dialog_element',   'dialog',    ARRAY['dialog', 'modal dialog', 'popup', 'alert dialog', 'modal window'], 'click', 0.85),
('alert_element',    'alert',     ARRAY['alert', 'error message', 'warning message', 'success message', 'notification', 'toast message'], 'click', 0.85),

-- ── Messaging & Chat ─────────────────────────────────────────────────────────
('chat_input',       'textbox', ARRAY['type a message', 'message', 'write a message', 'enter your message', 'send a text', 'type here', 'compose message', 'your message...'], 'type', 0.95),
('send_message_btn', 'button',  ARRAY['send', 'send message', 'submit message', 'transmit', 'send text', 'send chat', 'deliver'], 'click', 0.95),
('attach_file_btn',  'button',  ARRAY['attach', 'attach file', 'upload file', 'add attachment', 'choose file', 'insert file', 'clip'], 'click', 0.95),
('emoji_picker_btn', 'button',  ARRAY['emoji', 'emojis', 'smileys', 'insert emoji', 'add emoji', 'choose emoji', 'face'], 'click', 0.90),

-- ── Calendar & Scheduling ────────────────────────────────────────────────────
('date_picker_input','textbox', ARRAY['date', 'choose date', 'select date', 'pick a date', 'appointment date', 'booking date', 'schedule date', 'departure date', 'arrival date'], 'type', 0.95),
('time_picker_input','combobox',ARRAY['time', 'select time', 'choose time', 'pick a time', 'appointment time', 'start time', 'end time'], 'click', 0.95),
('next_month_btn',   'button',  ARRAY['next month', 'forward one month', 'go to next month', 'advance month', '>'], 'click', 0.90),
('prev_month_btn',   'button',  ARRAY['previous month', 'back one month', 'go to previous month', 'go back a month', '<'], 'click', 0.90),
('today_btn',        'button',  ARRAY['today', 'jump to today', 'current date', 'go to today'], 'click', 0.90),
('timezone_selector','combobox',ARRAY['timezone', 'select timezone', 'choose timezone', 'time zone', 'local time'], 'click', 0.95),

-- ── Finance & Payments ───────────────────────────────────────────────────────
('card_number_input','textbox', ARRAY['card number', 'credit card number', 'debit card number', 'card no', 'primary account number', 'pan'], 'type', 0.95),
('card_expiry_input','textbox', ARRAY['expiration date', 'expiry', 'mm/yy', 'exp', 'valid through', 'expires', 'expiry date', 'expiration', 'good thru'], 'type', 0.95),
('card_cvv_input',   'textbox', ARRAY['cvv', 'cvc', 'security code', 'csc', 'card security code', 'cvv2', 'security number'], 'type', 0.95),
('name_on_card',     'textbox', ARRAY['name on card', 'cardholder name', 'name as it appears on card', 'card holder'], 'type', 0.95),
('add_payment_btn',  'button',  ARRAY['add payment method', 'add new card', 'add card', 'link card', 'insert payment', 'save card'], 'click', 0.95),
('tip_selector',     'button',  ARRAY['add tip', 'tip amount', 'gratuity', 'leave a tip', 'custom tip'], 'click', 0.90),

-- ── E-commerce Extended ──────────────────────────────────────────────────────
('wishlist_button',  'button',  ARRAY['add to wishlist', 'wishlist', 'save for later', 'favorite item', 'add to favorites', 'heart', 'star'], 'click', 0.95),
('size_guide_link',  'link',    ARRAY['size guide', 'size chart', 'fit guide', 'find your size', 'sizing information', 'measurements'], 'click', 0.95),
('write_review_btn', 'button',  ARRAY['write a review', 'leave a review', 'rate this product', 'add a review', 'review this item', 'submit review', 'share your thoughts'], 'click', 0.95),
('out_of_stock_btn', 'button',  ARRAY['out of stock', 'notify me', 'notify me when available', 'email me when in stock', 'sold out', 'let me know'], 'click', 0.95),
('view_cart_btn',    'button',  ARRAY['view cart', 'go to cart', 'view bag', 'open cart', 'show cart', 'cart details'], 'click', 0.95),

-- ── Editor & Text Formatting ─────────────────────────────────────────────────
('bold_button',      'button',  ARRAY['bold', 'b', 'make bold', 'bold text'], 'click', 0.90),
('italic_button',    'button',  ARRAY['italic', 'i', 'make italic', 'italicize'], 'click', 0.90),
('underline_button', 'button',  ARRAY['underline', 'u', 'add underline', 'underline text'], 'click', 0.90),
('insert_link_btn',  'button',  ARRAY['insert link', 'add link', 'chain', 'hyperlink', 'link URL'], 'click', 0.90),
('bullet_list_btn',  'button',  ARRAY['bulleted list', 'ul', 'unordered list', 'bullets', 'bullet points', 'list'], 'click', 0.90),
('number_list_btn',  'button',  ARRAY['numbered list', 'ol', 'ordered list', 'numbers', 'numeric list'], 'click', 0.90),
('undo_button',      'button',  ARRAY['undo', 'reverse action', 'ctrl+z', 'undo typing'], 'click', 0.90),
('redo_button',      'button',  ARRAY['redo', 'repeat action', 'ctrl+y', 'redo typing'], 'click', 0.90),
('heading_selector', 'combobox',ARRAY['heading', 'style', 'paragraph format', 'text style', 'heading level', 'format'], 'click', 0.90),

-- ── Utilities & Accessibility ────────────────────────────────────────────────
('dark_mode_toggle', 'switch',  ARRAY['dark mode', 'theme toggle', 'light mode', 'toggle theme', 'switch theme', 'night mode', 'appearance'], 'click', 0.95),
('language_selector','combobox',ARRAY['language', 'select language', 'change language', 'choose language', 'locale', 'translate'], 'click', 0.95),
('font_size_increase','button', ARRAY['increase font size', 'text bigger', 'zoom in', 'make text larger', 'larger font', 'A+'], 'click', 0.90),
('font_size_decrease','button', ARRAY['decrease font size', 'text smaller', 'zoom out', 'make text smaller', 'smaller font', 'A-'], 'click', 0.90),
('reader_mode_btn',  'button',  ARRAY['reader mode', 'reading view', 'readability', 'focus mode', 'distraction free'], 'click', 0.90),

-- ── Maps & Location ──────────────────────────────────────────────────────────
('zoom_in_button',   'button',  ARRAY['zoom in', '+', 'magnify', 'closer', 'increase zoom'], 'click', 0.90),
('zoom_out_button',  'button',  ARRAY['zoom out', '-', 'minify', 'further', 'decrease zoom'], 'click', 0.90),
('my_location_btn',  'button',  ARRAY['my location', 'current location', 'find me', 'where am i', 'center on me', 'gps'], 'click', 0.95),
('search_area_btn',  'button',  ARRAY['search this area', 'redo search here', 'search in map', 'find here'], 'click', 0.95),
('get_directions_btn','button', ARRAY['get directions', 'directions', 'navigate', 'route', 'how to get there', 'start navigation'], 'click', 0.95),

-- ── More Form Elements ───────────────────────────────────────────────────────
('gender_radio',     'radio',   ARRAY['gender', 'sex', 'gender identity', 'what is your gender'], 'click', 0.90),
('terms_checkbox',   'checkbox',ARRAY['i agree to the terms', 'accept terms', 'agree to terms and conditions', 'i have read and agree to', 'accept conditions'], 'click', 0.95),
('newsletter_check', 'checkbox',ARRAY['subscribe to newsletter', 'send me updates', 'join mailing list', 'receive marketing emails', 'get promotional emails'], 'click', 0.95),
('upload_avatar_btn','button',  ARRAY['upload avatar', 'upload profile picture', 'change picture', 'select photo', 'choose image', 'update avatar'], 'click', 0.95),
('delete_account_btn','button', ARRAY['delete account', 'close account', 'deactivate account', 'remove account', 'terminate account', 'delete my profile'], 'click', 0.95),

-- ── Authentication & Security ────────────────────────────────────────────────
('forgot_password_link', 'link', ARRAY['forgot password', 'forgot password?', 'reset password', 'forgot your password?', 'trouble signing in?', 'recover account'], 'click', 0.95),
('totp_input',       'textbox', ARRAY['auth code', 'authenticator code', '2fa code', 'verification code', 'enter code', 'security code', 'otp', 'one time password'], 'type', 0.95),
('resend_code_btn',  'button', ARRAY['resend code', 'resend email', 'didn''t receive a code', 'send again'], 'click', 0.95),
('verify_btn',       'button', ARRAY['verify', 'verify identity', 'confirm code'], 'click', 0.95),

-- ── Cookie Consent ───────────────────────────────────────────────────────────
('accept_cookies_btn', 'button', ARRAY['accept all', 'allow all', 'got it', 'i accept', 'accept cookies', 'allow cookies', 'agree and continue'], 'click', 0.95),
('reject_cookies_btn', 'button', ARRAY['reject all', 'decline', 'reject optional', 'necessary only', 'essential cookies only'], 'click', 0.95),
('customize_cookies_btn', 'button', ARRAY['manage preferences', 'cookie settings', 'customize cookies', 'manage choices'], 'click', 0.95),

-- ── AI & Chatbots ────────────────────────────────────────────────────────────
('ai_prompt_input',  'textbox', ARRAY['ask ai', 'ask anything', 'type a prompt', 'message ai', 'chat with ai', 'how can i help?'], 'type', 0.95),
('ai_generate_btn',  'button', ARRAY['generate', 'create', 'imagine', 'write for me', 'summarize'], 'click', 0.95),
('ai_thumbs_up',     'button', ARRAY['good response', 'helpful', 'accurate'], 'click', 0.90),
('ai_thumbs_down',   'button', ARRAY['bad response', 'unhelpful', 'inaccurate', 'hallucination'], 'click', 0.90),
('ai_copy_response', 'button', ARRAY['copy response', 'copy code', 'copy to clipboard'], 'click', 0.95),

-- ── File Management ──────────────────────────────────────────────────────────
('new_folder_btn',   'button', ARRAY['new folder', 'create folder', 'add folder'], 'click', 0.95),
('upload_file_btn',  'button', ARRAY['upload', 'upload file', 'upload files', 'drag and drop'], 'click', 0.95),
('download_btn',     'button', ARRAY['download', 'download file', 'save to device', 'export'], 'click', 0.95),
('download_all_btn', 'button', ARRAY['download all', 'export all'], 'click', 0.95),
('trash_btn',        'button', ARRAY['trash', 'recycle bin', 'move to trash', 'delete file'], 'click', 0.95),
('empty_trash_btn',  'button', ARRAY['empty trash', 'empty recycle bin', 'permanently delete'], 'click', 0.95),
('rename_file_btn',  'button', ARRAY['rename', 'rename file', 'edit filename'], 'click', 0.95),
('copy_link_btn',    'button', ARRAY['copy link', 'get link', 'copy url', 'share link'], 'click', 0.95),

-- ── Advanced Navigation ──────────────────────────────────────────────────────
('skip_to_content',  'link', ARRAY['skip to content', 'skip to main content', 'skip navigation'], 'click', 0.95),
('back_to_top_btn',  'button', ARRAY['back to top', 'scroll to top', 'top', 'go up'], 'click', 0.95),
('breadcrumbs_nav',  'navigation', ARRAY['breadcrumbs', 'path', 'you are here'], 'click', 0.90),

-- ── Rating & Feedback ────────────────────────────────────────────────────────
('star_rating_input','slider', ARRAY['rate', 'rating', 'stars', 'give stars', 'rate experience'], 'click', 0.95),
('report_bug_btn',   'button', ARRAY['report bug', 'report an issue', 'found a bug?'], 'click', 0.95),
('send_feedback_btn','button', ARRAY['send feedback', 'give feedback', 'feedback'], 'click', 0.95),

-- ── Multi-step forms ─────────────────────────────────────────────────────────
('save_draft_btn',   'button', ARRAY['save as draft', 'save for later', 'save progress'], 'click', 0.95),
('review_submit_btn','button', ARRAY['review and submit', 'review order', 'final step'], 'click', 0.95),
('prev_step_btn',    'button', ARRAY['previous step', 'go back', 'back step'], 'click', 0.95),

-- ── Complex E-commerce ───────────────────────────────────────────────────────
('apply_gift_card',  'button', ARRAY['apply gift card', 'use gift card', 'redeem gift card', 'add gift card'], 'click', 0.95),
('express_checkout', 'button', ARRAY['express checkout', 'buy with shop pay', 'buy with apple pay', 'paypal checkout', 'fast checkout'], 'click', 0.95),
('compare_products', 'button', ARRAY['compare', 'add to compare', 'compare items'], 'click', 0.95),
('check_availability','button', ARRAY['check availability', 'check store stock', 'find in store', 'available near me'], 'click', 0.95)

ON CONFLICT (name) DO UPDATE
  SET name_patterns = EXCLUDED.name_patterns,
      action_hint   = EXCLUDED.action_hint,
      confidence    = EXCLUDED.confidence;
