#!/usr/bin/env python3
"""
GitLab account automation: signup + PAT creation using Camoufox browser automation.

Usage:
    python3 gitlab_duo.py --email 'user@example.com' --password 'mypassword' --headless
    python3 gitlab_duo.py --batch accounts.txt --headless
    echo 'user@example.com|password' | python3 gitlab_duo.py --batch - --headless

Batch format (one per line): email|password
Output: JSON (single mode) or JSONL (batch mode)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import re
import sys
import time
import traceback
from typing import Any

# Ensure the project root is importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

GITLAB_SIGNUP_URL = "https://gitlab.com/users/sign_up"
GITLAB_SIGNIN_URL = "https://gitlab.com/users/sign_in"
GITLAB_PAT_URL = "https://gitlab.com/-/user_settings/personal_access_tokens"

MAX_RETRIES = 3
RETRY_BASE_DELAY = 3.0
PAGE_TIMEOUT = 30000  # 30s default page timeout
NAV_TIMEOUT = 45000   # 45s navigation timeout

_EMAIL_PREFIX_RE = re.compile(r"^([^@]+)@")


def _derive_username(email: str) -> str:
    """Derive a GitLab-compatible username from email prefix."""
    match = _EMAIL_PREFIX_RE.match(email)
    if not match:
        return f"user{random.randint(10000, 99999)}"
    prefix = match.group(1)
    # GitLab usernames: alphanumeric, underscores, hyphens, dots; must start with letter/digit
    username = re.sub(r"[^a-zA-Z0-9_\-.]", "_", prefix)
    # Ensure it starts with a letter or digit
    if username and not username[0].isalnum():
        username = "u" + username
    # Add random suffix to avoid collisions
    username = f"{username}_{random.randint(1000, 9999)}"
    # GitLab max username length is 255
    return username[:255]


def _emit(data: dict) -> None:
    """Output JSON to stdout."""
    try:
        print(json.dumps(data), flush=True)
    except BrokenPipeError:
        pass


def _log(msg: str) -> None:
    """Log to stderr for debugging."""
    print(f"[gitlab-duo] {msg}", file=sys.stderr, flush=True)


async def _create_browser(headless: bool = True) -> dict[str, Any]:
    """Create a Camoufox browser session."""
    from browserforge.fingerprints import Screen
    from camoufox.async_api import AsyncCamoufox

    camoufox_kwargs: dict[str, Any] = {
        # Use "virtual" (Xvfb) instead of True to bypass Cloudflare turnstile detection
        "headless": "virtual" if headless else False,
        "os": "windows",
        "block_webrtc": True,
        "humanize": True,
        "screen": Screen(max_width=1920, max_height=1080),
    }

    # Proxy support
    proxy_url = os.getenv("BATCHER_PROXY_URL", "") or os.getenv("HTTPS_PROXY", "") or os.getenv("HTTP_PROXY", "")
    if proxy_url:
        from urllib.parse import urlparse
        parsed = urlparse(proxy_url)
        proxy_cfg: dict[str, Any] = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
        if parsed.username:
            proxy_cfg["username"] = parsed.username
        if parsed.password:
            proxy_cfg["password"] = parsed.password
        camoufox_kwargs["proxy"] = proxy_cfg
        camoufox_kwargs["geoip"] = True

    manager = AsyncCamoufox(**camoufox_kwargs)
    browser = await manager.__aenter__()
    page = await browser.new_page()
    page.set_default_timeout(PAGE_TIMEOUT)

    return {
        "manager": manager,
        "browser": browser,
        "page": page,
    }


async def _cleanup_browser(session: dict[str, Any]) -> None:
    """Clean up browser session."""
    try:
        manager = session.get("manager")
        if manager:
            await manager.__aexit__(None, None, None)
    except Exception:
        pass


async def _type_slowly(page: Any, selector: str, text: str, delay: int = 50) -> None:
    """Type text into a field character by character with human-like delay."""
    locator = page.locator(selector).first
    await locator.click()
    await asyncio.sleep(0.2)
    # Clear existing content
    try:
        await locator.press("Control+a")
        await locator.press("Backspace")
    except Exception:
        pass
    await asyncio.sleep(0.1)
    await locator.press_sequentially(text, delay=delay)


async def _wait_for_cloudflare(page: Any, timeout_s: int = 30) -> bool:
    """Wait for Cloudflare challenge to resolve. Returns True if passed."""
    for i in range(timeout_s // 2):
        # Check if we already have the real page
        login_field = await page.query_selector('#user_login, input[name="user[login]"], #new_user_username')
        if login_field:
            return True

        # Try to find and click the turnstile iframe checkbox
        frames = page.frames
        cf_frames = [f for f in frames if 'challenges.cloudflare.com' in f.url]
        if cf_frames:
            try:
                cf_frame = cf_frames[0]
                cb = await cf_frame.query_selector('input[type="checkbox"]')
                if cb:
                    await cb.click()
                else:
                    await cf_frame.click('body')
            except Exception:
                pass

        await asyncio.sleep(2)

    return False

async def _check_captcha(page: Any) -> bool:
    """Check if a CAPTCHA is present on the page."""
    captcha_indicators = [
        "iframe[src*='recaptcha']",
        "iframe[src*='hcaptcha']",
        "iframe[src*='captcha']",
        ".g-recaptcha",
        "#captcha",
        "[data-sitekey]",
        "iframe[src*='arkose']",
        ".cf-turnstile",
    ]
    for selector in captcha_indicators:
        try:
            count = await page.locator(selector).count()
            if count > 0:
                return True
        except Exception:
            pass
    return False


async def _check_rate_limit(page: Any) -> bool:
    """Check if we're being rate limited."""
    try:
        title = await page.title()
        # Don't flag CF challenge pages as rate limited
        cf_titles = ["just a moment", "un momento", "tunggu sebentar", "трохи зачекайте", "einen moment"]
        if any(t in title.lower() for t in cf_titles):
            return False
        content = await page.content()
        rate_limit_indicators = [
            "rate limit",
            "too many requests",
            "please try again later",
            "temporarily blocked",
        ]
        content_lower = content.lower()
        return any(indicator in content_lower for indicator in rate_limit_indicators)
    except Exception:
        return False


async def _check_already_registered(page: Any) -> bool:
    """Check if the email is already registered."""
    try:
        content = await page.content()
        indicators = [
            "email has already been taken",
            "already been taken",
            "is already registered",
            "email is already in use",
        ]
        content_lower = content.lower()
        return any(indicator in content_lower for indicator in indicators)
    except Exception:
        return False


async def _signup(page: Any, email: str, password: str) -> dict[str, Any]:
    """
    Perform GitLab signup.
    Returns: {"success": True} or {"success": False, "error": "...", "needs_verification": bool}
    """
    username = _derive_username(email)
    _log(f"Signing up with username: {username}")

    # Navigate to signup page
    await page.goto(GITLAB_SIGNUP_URL, wait_until="domcontentloaded", timeout=NAV_TIMEOUT)
    await asyncio.sleep(2)

    # Check for rate limiting
    if await _check_rate_limit(page):
        return {"success": False, "error": "Rate limited on signup page", "rate_limited": True}

    # Fill in the registration form
    # GitLab signup form fields
    form_fields = [
        ("#new_user_first_name", "User"),
        ("#new_user_last_name", "Test"),
        ("#new_user_username", username),
        ("#new_user_email", email),
        ("#new_user_password", password),
    ]

    for selector, value in form_fields:
        try:
            await page.wait_for_selector(selector, state="visible", timeout=10000)
            await _type_slowly(page, selector, value, delay=random.randint(30, 70))
            await asyncio.sleep(random.uniform(0.3, 0.8))
        except Exception as exc:
            _log(f"Failed to fill field {selector}: {exc}")
            # Try alternative selectors
            alt_selectors = {
                "#new_user_first_name": ['input[name="user[first_name]"]', 'input[data-testid="new-user-first-name-field"]'],
                "#new_user_last_name": ['input[name="user[last_name]"]', 'input[data-testid="new-user-last-name-field"]'],
                "#new_user_username": ['input[name="user[username]"]', 'input[data-testid="new-user-username-field"]'],
                "#new_user_email": ['input[name="user[email]"]', 'input[data-testid="new-user-email-field"]'],
                "#new_user_password": ['input[name="user[password]"]', 'input[data-testid="new-user-password-field"]'],
            }
            filled = False
            for alt_sel in alt_selectors.get(selector, []):
                try:
                    count = await page.locator(alt_sel).count()
                    if count > 0:
                        await _type_slowly(page, alt_sel, value, delay=random.randint(30, 70))
                        filled = True
                        break
                except Exception:
                    continue
            if not filled:
                return {"success": False, "error": f"Could not fill signup field: {selector}"}

    await asyncio.sleep(1)

    # Check for CAPTCHA before submitting
    if await _check_captcha(page):
        _log("WARNING: CAPTCHA detected on signup form")
        return {"success": False, "error": "CAPTCHA detected - cannot solve automatically", "captcha": True}

    # Submit the form
    submit_selectors = [
        'button[data-testid="new-user-register-button"]',
        'input[type="submit"][name="commit"]',
        'button[type="submit"]',
        '#new_user button[type="submit"]',
        'input[value="Register"]',
    ]

    submitted = False
    for sel in submit_selectors:
        try:
            count = await page.locator(sel).count()
            if count > 0:
                await page.locator(sel).first.click()
                submitted = True
                _log(f"Clicked submit button: {sel}")
                break
        except Exception:
            continue

    if not submitted:
        # Try pressing Enter on the password field as fallback
        try:
            await page.locator("#new_user_password").first.press("Enter")
            submitted = True
            _log("Submitted form via Enter key")
        except Exception:
            return {"success": False, "error": "Could not find or click submit button"}

    # Wait for response
    await asyncio.sleep(3)

    # Check for errors
    if await _check_already_registered(page):
        return {"success": False, "error": "Email already registered", "already_registered": True}

    if await _check_rate_limit(page):
        return {"success": False, "error": "Rate limited after signup submission", "rate_limited": True}

    if await _check_captcha(page):
        return {"success": False, "error": "CAPTCHA appeared after submission", "captcha": True}

    # Check for error messages on the page
    try:
        error_selectors = [
            ".flash-alert",
            ".alert-danger",
            "#error_explanation",
            ".gl-alert-danger",
            '[data-testid="alert-danger"]',
        ]
        for err_sel in error_selectors:
            count = await page.locator(err_sel).count()
            if count > 0:
                error_text = await page.locator(err_sel).first.inner_text()
                if error_text.strip():
                    _log(f"Signup error: {error_text.strip()}")
                    return {"success": False, "error": f"Signup error: {error_text.strip()}"}
    except Exception:
        pass

    # Check if we need email verification
    current_url = page.url
    page_content = await page.content()
    content_lower = page_content.lower()

    if "almost there" in content_lower or "confirm your email" in content_lower or "verification" in content_lower:
        _log("Email verification required - account created but needs confirmation")
        return {
            "success": True,
            "needs_verification": True,
            "message": "Account created - email verification required",
            "username": username,
        }

    # If we're redirected to dashboard or welcome page, signup succeeded
    if "dashboard" in current_url or "welcome" in current_url or "projects" in current_url:
        _log("Signup successful - redirected to dashboard")
        return {"success": True, "needs_verification": False, "username": username}

    # Check if we ended up on a "check your email" page
    if "check" in content_lower and "email" in content_lower:
        _log("Email verification required")
        return {
            "success": True,
            "needs_verification": True,
            "message": "Account created - check email for verification",
            "username": username,
        }

    _log(f"Signup result unclear. URL: {current_url}")
    return {
        "success": True,
        "needs_verification": True,
        "message": "Signup submitted - verification status unclear",
        "username": username,
    }


async def _login(page: Any, email: str, password: str) -> dict[str, Any]:
    """
    Perform GitLab login.
    Returns: {"success": True} or {"success": False, "error": "..."}
    """
    _log("Logging in...")

    await page.goto(GITLAB_SIGNIN_URL, wait_until="domcontentloaded", timeout=NAV_TIMEOUT)
    await asyncio.sleep(2)

    # Wait for Cloudflare challenge to resolve
    cf_passed = await _wait_for_cloudflare(page, timeout_s=30)
    if not cf_passed:
        return {"success": False, "error": "Cloudflare challenge did not resolve"}

    # Check for rate limiting
    if await _check_rate_limit(page):
        return {"success": False, "error": "Rate limited on login page", "rate_limited": True}

    # Fill login form
    login_email_selectors = [
        "#user_login",
        'input[name="user[login]"]',
        'input[data-testid="username-field"]',
        'input[id="user_login"]',
    ]

    login_password_selectors = [
        "#user_password",
        'input[name="user[password]"]',
        'input[data-testid="password-field"]',
        'input[id="user_password"]',
    ]

    # Fill email/username
    filled_email = False
    for sel in login_email_selectors:
        try:
            count = await page.locator(sel).count()
            if count > 0 and await page.locator(sel).first.is_visible():
                await _type_slowly(page, sel, email, delay=random.randint(30, 60))
                filled_email = True
                break
        except Exception:
            continue

    if not filled_email:
        return {"success": False, "error": "Could not find login email field"}

    await asyncio.sleep(random.uniform(0.3, 0.7))

    # Fill password
    filled_password = False
    for sel in login_password_selectors:
        try:
            count = await page.locator(sel).count()
            if count > 0 and await page.locator(sel).first.is_visible():
                await _type_slowly(page, sel, password, delay=random.randint(30, 60))
                filled_password = True
                break
        except Exception:
            continue

    if not filled_password:
        return {"success": False, "error": "Could not find login password field"}

    await asyncio.sleep(0.5)

    # Check for CAPTCHA
    if await _check_captcha(page):
        return {"success": False, "error": "CAPTCHA detected on login", "captcha": True}

    # Submit login
    submit_selectors = [
        'button[data-testid="sign-in-button"]',
        'input[type="submit"][name="commit"]',
        'button[type="submit"]',
        'input[value="Sign in"]',
    ]

    submitted = False
    for sel in submit_selectors:
        try:
            count = await page.locator(sel).count()
            if count > 0:
                await page.locator(sel).first.click()
                submitted = True
                break
        except Exception:
            continue

    if not submitted:
        try:
            await page.keyboard.press("Enter")
            submitted = True
        except Exception:
            return {"success": False, "error": "Could not submit login form"}

    # Wait for navigation
    await asyncio.sleep(3)

    # Check result
    current_url = page.url
    if "sign_in" in current_url:
        # Still on login page - check for errors
        try:
            error_text = ""
            for err_sel in [".flash-alert", ".alert-danger", ".gl-alert-danger"]:
                count = await page.locator(err_sel).count()
                if count > 0:
                    error_text = await page.locator(err_sel).first.inner_text()
                    break
            if error_text:
                return {"success": False, "error": f"Login failed: {error_text.strip()}"}
        except Exception:
            pass
        return {"success": False, "error": "Login failed - still on sign_in page"}

    # Check if 2FA is required
    if "two_factor" in current_url or "otp" in current_url:
        return {"success": False, "error": "Two-factor authentication required"}

    _log(f"Login successful. Current URL: {current_url}")
    return {"success": True}


async def _create_pat(page: Any, token_name: str = "etteum-pool-token") -> dict[str, Any]:
    """
    Create a Personal Access Token.
    Returns: {"success": True, "pat": "glpat-..."} or {"success": False, "error": "..."}
    """
    _log("Creating PAT...")

    # Navigate to PAT page
    await page.goto(GITLAB_PAT_URL, wait_until="domcontentloaded", timeout=NAV_TIMEOUT)
    await asyncio.sleep(2)

    # Check if we're redirected to login (session expired)
    if "sign_in" in page.url:
        return {"success": False, "error": "Session expired - redirected to login"}

    # Click "Add new token" button if present
    add_token_selectors = [
        'a[data-testid="add-new-token-button"]',
        'a:has-text("Add new token")',
        'button:has-text("Add new token")',
        '.gl-new-dropdown-item:has-text("Add new token")',
        'a[href*="personal_access_tokens/new"]',
    ]

    for sel in add_token_selectors:
        try:
            count = await page.locator(sel).count()
            if count > 0 and await page.locator(sel).first.is_visible():
                await page.locator(sel).first.click()
                await asyncio.sleep(2)
                break
        except Exception:
            continue

    # Fill token name
    name_selectors = [
        "#personal_access_token_name",
        'input[name="personal_access_token[name]"]',
        'input[data-testid="token-name-field"]',
        'input[placeholder*="name"]',
        '#token-name',
    ]

    filled_name = False
    for sel in name_selectors:
        try:
            count = await page.locator(sel).count()
            if count > 0 and await page.locator(sel).first.is_visible():
                await _type_slowly(page, sel, token_name, delay=random.randint(30, 50))
                filled_name = True
                _log(f"Filled token name with selector: {sel}")
                break
        except Exception:
            continue

    if not filled_name:
        return {"success": False, "error": "Could not find token name field"}

    await asyncio.sleep(0.5)

    # Set expiration date (max 1 year from now)
    expiry_selectors = [
        "#personal_access_token_expires_at",
        'input[name="personal_access_token[expires_at]"]',
        'input[data-testid="token-expiry-field"]',
        'input[placeholder*="YYYY-MM-DD"]',
    ]

    # Calculate date 364 days from now
    from datetime import datetime, timedelta
    expiry_date = (datetime.now() + timedelta(days=364)).strftime("%Y-%m-%d")

    for sel in expiry_selectors:
        try:
            count = await page.locator(sel).count()
            if count > 0:
                locator = page.locator(sel).first
                await locator.click()
                await asyncio.sleep(0.2)
                await locator.press("Control+a")
                await locator.press("Backspace")
                await locator.press_sequentially(expiry_date, delay=30)
                # Press Escape to close any date picker
                await page.keyboard.press("Escape")
                _log(f"Set expiry date: {expiry_date}")
                break
        except Exception:
            continue

    await asyncio.sleep(0.5)

    # Select scopes: api, read_user
    scope_selectors = {
        "api": [
            '#personal_access_token_scopes_api',
            'input[value="api"]',
            'input[name="personal_access_token[scopes][]"][value="api"]',
            'label:has-text("api") input[type="checkbox"]',
        ],
        "read_user": [
            '#personal_access_token_scopes_read_user',
            'input[value="read_user"]',
            'input[name="personal_access_token[scopes][]"][value="read_user"]',
            'label:has-text("read_user") input[type="checkbox"]',
        ],
    }

    for scope_name, selectors in scope_selectors.items():
        checked = False
        for sel in selectors:
            try:
                count = await page.locator(sel).count()
                if count > 0:
                    locator = page.locator(sel).first
                    is_checked = await locator.is_checked()
                    if not is_checked:
                        await locator.check()
                    checked = True
                    _log(f"Checked scope: {scope_name}")
                    break
            except Exception:
                continue

        if not checked:
            # Try clicking the label instead
            try:
                label_sel = f'label:has-text("{scope_name}")'
                count = await page.locator(label_sel).count()
                if count > 0:
                    await page.locator(label_sel).first.click()
                    checked = True
                    _log(f"Clicked label for scope: {scope_name}")
            except Exception:
                pass

        if not checked:
            _log(f"WARNING: Could not check scope: {scope_name}")

    await asyncio.sleep(0.5)

    # Submit the form to create the token
    create_selectors = [
        'input[type="submit"][value="Create personal access token"]',
        'button:has-text("Create personal access token")',
        'input[name="commit"]',
        'button[type="submit"]',
        'button[data-testid="create-token-button"]',
    ]

    submitted = False
    for sel in create_selectors:
        try:
            count = await page.locator(sel).count()
            if count > 0 and await page.locator(sel).first.is_visible():
                await page.locator(sel).first.click()
                submitted = True
                _log(f"Clicked create token button: {sel}")
                break
        except Exception:
            continue

    if not submitted:
        return {"success": False, "error": "Could not find or click create token button"}

    # Wait for token to be created
    await asyncio.sleep(3)

    # Extract the PAT value
    pat_selectors = [
        '#created-personal-access-token',
        'input[data-testid="created-personal-access-token"]',
        'input[name="created-personal-access-token"]',
        '#new_token',
        'input[id="created-personal-access-token"]',
        '.gl-alert-body code',
        'button[data-testid="clipboard-btn"]',
    ]

    pat_value = ""
    for sel in pat_selectors:
        try:
            count = await page.locator(sel).count()
            if count > 0:
                locator = page.locator(sel).first
                # Try input value first
                try:
                    pat_value = await locator.input_value()
                except Exception:
                    pass
                # Try text content
                if not pat_value:
                    try:
                        pat_value = await locator.inner_text()
                    except Exception:
                        pass
                # Try data-clipboard-text attribute
                if not pat_value:
                    try:
                        pat_value = await locator.get_attribute("data-clipboard-text")
                    except Exception:
                        pass
                if pat_value and pat_value.startswith("glpat-"):
                    _log(f"Found PAT: {pat_value[:12]}...")
                    break
                pat_value = ""
        except Exception:
            continue

    # Also try to find it via clipboard button's data attribute
    if not pat_value:
        try:
            clipboard_btns = page.locator('[data-clipboard-text]')
            count = await clipboard_btns.count()
            for i in range(count):
                val = await clipboard_btns.nth(i).get_attribute("data-clipboard-text")
                if val and val.startswith("glpat-"):
                    pat_value = val
                    break
        except Exception:
            pass

    # Try to find it in the page content via regex
    if not pat_value:
        try:
            content = await page.content()
            match = re.search(r'(glpat-[A-Za-z0-9_\-]{20,})', content)
            if match:
                pat_value = match.group(1)
                _log(f"Found PAT via regex: {pat_value[:12]}...")
        except Exception:
            pass

    if pat_value and pat_value.startswith("glpat-"):
        return {"success": True, "pat": pat_value}

    # Check for errors
    try:
        error_text = ""
        for err_sel in [".flash-alert", ".alert-danger", ".gl-alert-danger", "#error_explanation"]:
            count = await page.locator(err_sel).count()
            if count > 0:
                error_text = await page.locator(err_sel).first.inner_text()
                break
        if error_text:
            return {"success": False, "error": f"PAT creation error: {error_text.strip()}"}
    except Exception:
        pass

    return {"success": False, "error": "Could not extract PAT value after creation"}


async def process_account(email: str, password: str, headless: bool = True) -> dict[str, Any]:
    """
    Full flow: signup -> login -> create PAT.
    Returns JSON result.
    """
    session = None
    last_error = ""

    for attempt in range(MAX_RETRIES):
        try:
            if attempt > 0:
                delay = RETRY_BASE_DELAY * (2 ** (attempt - 1))
                _log(f"Retry {attempt + 1}/{MAX_RETRIES} after {delay:.0f}s delay...")
                await asyncio.sleep(delay)

            # Create browser
            _log(f"Starting browser (attempt {attempt + 1}/{MAX_RETRIES})...")
            session = await _create_browser(headless=headless)
            page = session["page"]

            # Step 1: Signup
            _log("Step 1: Signup")
            signup_result = await _signup(page, email, password)

            if not signup_result["success"]:
                if signup_result.get("already_registered"):
                    _log("Email already registered - skipping to login")
                elif signup_result.get("rate_limited"):
                    last_error = signup_result["error"]
                    await _cleanup_browser(session)
                    session = None
                    continue  # Retry
                elif signup_result.get("captcha"):
                    return {"success": False, "error": signup_result["error"]}
                else:
                    # Non-retryable signup error but try login anyway
                    _log(f"Signup issue: {signup_result['error']} - attempting login anyway")

            # If verification is needed, we can't proceed with PAT creation
            if signup_result.get("needs_verification"):
                _log("Email verification required - cannot create PAT automatically")
                return {
                    "success": False,
                    "error": "Email verification required - confirm email and re-run with login only",
                    "needs_verification": True,
                    "username": signup_result.get("username", ""),
                }

            # Step 2: Login
            _log("Step 2: Login")
            login_result = await _login(page, email, password)

            if not login_result["success"]:
                if login_result.get("rate_limited"):
                    last_error = login_result["error"]
                    await _cleanup_browser(session)
                    session = None
                    continue  # Retry
                elif login_result.get("captcha"):
                    return {"success": False, "error": login_result["error"]}
                else:
                    return {"success": False, "error": login_result["error"]}

            # Step 3: Create PAT
            _log("Step 3: Create PAT")
            pat_result = await _create_pat(page)

            if pat_result["success"]:
                return {"success": True, "pat": pat_result["pat"]}
            else:
                last_error = pat_result["error"]
                # PAT creation failure might be retryable
                if "session expired" in last_error.lower():
                    await _cleanup_browser(session)
                    session = None
                    continue
                return {"success": False, "error": last_error}

        except Exception as exc:
            last_error = str(exc)
            _log(f"Error on attempt {attempt + 1}: {last_error}")
            if "net::" in last_error.lower() or "timeout" in last_error.lower():
                # Network error - retry
                if session:
                    await _cleanup_browser(session)
                    session = None
                continue
            # Unknown error
            _log(traceback.format_exc())
            if session:
                await _cleanup_browser(session)
                session = None
            continue
        finally:
            if session:
                await _cleanup_browser(session)
                session = None

    return {"success": False, "error": f"All {MAX_RETRIES} attempts failed. Last error: {last_error}"}


async def process_account_login_only(email: str, password: str, headless: bool = True) -> dict[str, Any]:
    """
    Login-only flow (for already-registered accounts): login -> create PAT.
    """
    session = None
    last_error = ""

    for attempt in range(MAX_RETRIES):
        try:
            if attempt > 0:
                delay = RETRY_BASE_DELAY * (2 ** (attempt - 1))
                _log(f"Retry {attempt + 1}/{MAX_RETRIES} after {delay:.0f}s delay...")
                await asyncio.sleep(delay)

            session = await _create_browser(headless=headless)
            page = session["page"]

            # Login
            _log("Logging in...")
            login_result = await _login(page, email, password)

            if not login_result["success"]:
                if login_result.get("rate_limited"):
                    last_error = login_result["error"]
                    await _cleanup_browser(session)
                    session = None
                    continue
                return {"success": False, "error": login_result["error"]}

            # Create PAT
            _log("Creating PAT...")
            pat_result = await _create_pat(page)

            if pat_result["success"]:
                return {"success": True, "pat": pat_result["pat"]}
            else:
                return {"success": False, "error": pat_result["error"]}

        except Exception as exc:
            last_error = str(exc)
            _log(f"Error on attempt {attempt + 1}: {last_error}")
            if session:
                await _cleanup_browser(session)
                session = None
            continue
        finally:
            if session:
                await _cleanup_browser(session)
                session = None

    return {"success": False, "error": f"All {MAX_RETRIES} attempts failed. Last error: {last_error}"}


async def batch_process(accounts: list[tuple[str, str]], headless: bool = True, delay: float = 5.0, login_only: bool = False) -> None:
    """
    Process multiple accounts sequentially.
    Outputs JSONL (one JSON object per line).
    """
    for i, (email, password) in enumerate(accounts):
        _log(f"Processing account {i + 1}/{len(accounts)}: {email}")

        if login_only:
            result = await process_account_login_only(email, password, headless=headless)
        else:
            result = await process_account(email, password, headless=headless)

        result["email"] = email
        _emit(result)

        # Delay between accounts (except after the last one)
        if i < len(accounts) - 1:
            jitter = random.uniform(0, delay * 0.3)
            wait_time = delay + jitter
            _log(f"Waiting {wait_time:.1f}s before next account...")
            await asyncio.sleep(wait_time)


def _parse_batch_input(source: str) -> list[tuple[str, str]]:
    """Parse batch input (file path or '-' for stdin). Format: email|password per line."""
    accounts = []

    if source == "-":
        lines = sys.stdin.read().strip().split("\n")
    else:
        with open(source, "r") as f:
            lines = f.read().strip().split("\n")

    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("|", 1)
        if len(parts) != 2:
            _log(f"Skipping invalid line (expected email|password): {line}")
            continue
        email, password = parts[0].strip(), parts[1].strip()
        if not email or not password:
            _log(f"Skipping line with empty email or password: {line}")
            continue
        accounts.append((email, password))

    return accounts


async def main():
    parser = argparse.ArgumentParser(
        description="GitLab account automation: signup + PAT creation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Single account signup + PAT
  python3 gitlab_duo.py --email 'user@example.com' --password 'pass123'

  # Login only (skip signup, for already-registered accounts)
  python3 gitlab_duo.py --email 'user@example.com' --password 'pass123' --login-only

  # Batch mode from file
  python3 gitlab_duo.py --batch accounts.txt

  # Batch mode from stdin
  echo 'user@example.com|pass123' | python3 gitlab_duo.py --batch -

  # Non-headless (visible browser for debugging)
  python3 gitlab_duo.py --email 'user@example.com' --password 'pass123' --no-headless
""",
    )

    parser.add_argument("--email", help="Email address for signup/login")
    parser.add_argument("--password", help="Password for the account")
    parser.add_argument("--headless", action="store_true", default=True, help="Run browser in headless mode (default)")
    parser.add_argument("--no-headless", action="store_true", help="Run browser with visible window (for debugging)")
    parser.add_argument("--login-only", action="store_true", help="Skip signup, only login and create PAT")
    parser.add_argument("--batch", metavar="FILE", help="Batch mode: read accounts from file (or '-' for stdin). Format: email|password per line")
    parser.add_argument("--delay", type=float, default=5.0, help="Delay between accounts in batch mode (seconds, default: 5)")

    args = parser.parse_args()

    headless = not args.no_headless

    if args.batch:
        # Batch mode
        accounts = _parse_batch_input(args.batch)
        if not accounts:
            _emit({"success": False, "error": "No valid accounts found in batch input"})
            sys.exit(1)
        _log(f"Batch mode: {len(accounts)} accounts to process")
        await batch_process(accounts, headless=headless, delay=args.delay, login_only=args.login_only)
    elif args.email and args.password:
        # Single account mode
        if args.login_only:
            result = await process_account_login_only(args.email, args.password, headless=headless)
        else:
            result = await process_account(args.email, args.password, headless=headless)
        _emit(result)
        if not result["success"]:
            sys.exit(1)
    else:
        parser.error("Either --email and --password, or --batch must be provided")


if __name__ == "__main__":
    asyncio.run(main())
