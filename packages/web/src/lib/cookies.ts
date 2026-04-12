export const ACCESS_COOKIE  = 'kaizen_access';
export const REFRESH_COOKIE = 'kaizen_refresh';

const isProduction = process.env.NODE_ENV === 'production';

export const ACCESS_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 15 * 60, // 15 minutes — matches backend ACCESS_TOKEN_TTL
};

export const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 30 * 24 * 60 * 60, // 30 days — matches backend REFRESH_TOKEN_TTL_DAYS
};
