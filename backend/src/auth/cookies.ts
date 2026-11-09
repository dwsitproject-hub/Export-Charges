import type { CookieOptions } from 'express';
import type { AppConfig } from '../config';

/**
 * Session cookie: SameSite=Strict, Path=/ (`__Host-` prefix over HTTPS).
 * Login-state cookie: SameSite=Lax, because the DWS Hub callback is a cross-site top-level navigation.
 */
export function cookieNames(config: AppConfig) {
  return config.cookieSecure
    ? { session: '__Host-ecr_sid', login: '__Secure-ecr_login', relaunch: '__Secure-ecr_relaunch' }
    : { session: 'ecr_sid', login: 'ecr_login', relaunch: 'ecr_relaunch' };
}

/** Marks a sign-in ECR just restarted by itself, so an unusable callback is never restarted twice in a row. */
export function relaunchCookieOptions(config: AppConfig): CookieOptions {
  return { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/api/auth', maxAge: 60 * 1000 };
}

export function relaunchCookieClearOptions(config: AppConfig): CookieOptions {
  const { maxAge: _maxAge, ...rest } = relaunchCookieOptions(config);
  return rest;
}

export function sessionCookieOptions(config: AppConfig): CookieOptions {
  return { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/' };
}

/** Options for clearing the login cookie (Express ignores maxAge on clearCookie). */
export function loginCookieClearOptions(config: AppConfig): CookieOptions {
  const { maxAge: _maxAge, ...rest } = loginCookieOptions(config);
  return rest;
}

export function loginCookieOptions(config: AppConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: config.loginStateMinutes * 60 * 1000,
  };
}
