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
        "disable_coop": True,  # Allow clicking turnstile checkbox in cross-origin iframe
        "i_know_what_im_doing": True,
        "screen": Screen(max_width=1920, max_height=1080),
        "window": (1280, 900),
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
        login_field = await page.query_selector('#user_login, input[name="user[login]"], #new_user_username, #identifierId')
        if login_field:
            return True

        # Check if URL changed away from challenge
        title = await page.title()
        cf_titles = ["just a moment", "un momento", "tunggu sebentar", "трохи зачекайте", "einen moment", "verificación"]
        if not any(t in title.lower() for t in cf_titles):
            # Title doesn't look like CF anymore
            await asyncio.sleep(1)
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

        # Also try clicking turnstile widget directly on the page (non-iframe rendering)
        try:
            turnstile_widget = await page.query_selector('.cf-turnstile iframe, iframe[src*="turnstile"]')
            if turnstile_widget:
                box = await turnstile_widget.bounding_box()
                if box:
                    # Click in the left portion where the checkbox is
                    await page.mouse.click(box['x'] + 25, box['y'] + box['height'] / 2)
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


async def _verify_email_via_gmail(page: Any, email: str, password: str) -> dict[str, Any]:
    """
    Log into Gmail and click the GitLab email confirmation link.
    Reuses the same browser page.
    Returns: {"success": True} or {"success": False, "error": "..."}
    """
    _log("Verifying email via Gmail...")
    return await _gmail_get_gitlab_code_or_link(page, email, password, mode="link")


async def _solve_arkose_if_present(page: Any) -> bool:
    """
    Detect and solve Arkose Labs/FunCaptcha challenge using Capsolver.
    Returns True if solved (or no challenge present), False if failed.
    """
    import re as _re

    # Check if Arkose iframe is present
    content = await page.content()
    frames = page.frames
    arkose_frames = [f for f in frames if 'arkoselabs.com' in f.url or 'funcaptcha' in f.url]

    # Also check for arkose in page HTML
    has_arkose = bool(arkose_frames) or 'arkoselabs' in content.lower() or 'funcaptcha' in content.lower()

    if not has_arkose:
        return True  # No challenge present

    _log("Arkose Labs challenge detected, solving with Capsolver...")

    # Extract the public key from the page
    public_key = None
    keys = _re.findall(r'[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}', content)
    if keys:
        public_key = keys[0]
    else:
        for f in arkose_frames:
            key_match = _re.search(r'[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}', f.url)
            if key_match:
                public_key = key_match.group(0)
                break

    if not public_key:
        # GitLab's known identity verification Arkose key
        public_key = "2CB16598-CB82-4CF7-B332-5990DB66F3AB"

    _log(f"Arkose public key: {public_key}")

    try:
        import urllib.request as _urllib_request

        captcha_api_key = os.getenv("CAPTCHA_API_KEY", "")
        if not captcha_api_key:
            _log("No CAPTCHA_API_KEY set, cannot solve Arkose")
            return False

        # Submit to 2captcha
        submit_url = (
            f"https://2captcha.com/in.php?key={captcha_api_key}&method=funcaptcha"
            f"&publickey={public_key}"
            f"&pageurl={page.url}"
            f"&surl=https://gitlab-api.arkoselabs.com&json=1"
        )
        resp = _urllib_request.urlopen(submit_url, timeout=30)
        result = json.loads(resp.read())

        if result.get("status") != 1:
            _log(f"2captcha submit failed: {result}")
            return False

        task_id = result["request"]
        _log(f"2captcha task submitted: {task_id}, waiting for solution...")

        # Poll for result (up to 120s)
        import time as _time
        for i in range(24):
            await asyncio.sleep(5)
            poll_url = f"https://2captcha.com/res.php?key={captcha_api_key}&action=get&id={task_id}&json=1"
            poll_resp = _urllib_request.urlopen(poll_url, timeout=15)
            poll_result = json.loads(poll_resp.read())

            if poll_result.get("status") == 1:
                token = poll_result["request"]
                _log(f"Arkose solved! Token: {token[:60]}...")
                break
            elif "CAPCHA_NOT_READY" not in poll_result.get("request", ""):
                _log(f"2captcha error: {poll_result}")
                return False
        else:
            _log("2captcha timeout after 120s")
            return False

        # Inject the token into the page
        inject_result = await page.evaluate("""(token) => {
            // Try hidden input
            const tokenInput = document.querySelector('input[name="arkose_labs_token"]') ||
                               document.querySelector('input[name="verification_token"]') ||
                               document.querySelector('#arkose-token') ||
                               document.querySelector('[name*="arkose"]');
            if (tokenInput) {
                tokenInput.value = token;
                tokenInput.dispatchEvent(new Event('input', {bubbles: true}));
                tokenInput.dispatchEvent(new Event('change', {bubbles: true}));
                return 'input';
            }
            // Try global callback
            if (window.arkoseCallback) {
                window.arkoseCallback({token: token});
                return 'callback';
            }
            if (window.setupArkoseLabsChallenge) {
                return 'setup_found';
            }
            // Dispatch event for any listeners
            document.dispatchEvent(new CustomEvent('arkose-complete', {detail: {token: token}}));
            return 'event';
        }""", token)

        _log(f"Token injection method: {inject_result}")
        await asyncio.sleep(3)
        return True

    except Exception as e:
        _log(f"Arkose solve failed: {e}")
        return False


async def _verify_identity_code(page: Any, email: str, password: str) -> dict[str, Any]:
    """
    Handle GitLab identity verification: get code from Gmail and enter it.
    The page should currently be on /users/identity_verification.
    """
    _log("Handling identity verification code...")

    # Save the current verification page URL
    verify_url = page.url

    # Get the verification code from Gmail
    result = await _gmail_get_gitlab_code_or_link(page, email, password, mode="code")
    if not result["success"]:
        return result

    code = result.get("code", "")
    if not code:
        return {"success": False, "error": "No verification code found in Gmail"}

    _log(f"Got verification code: {code}")

    # Navigate back to GitLab verification page
    await page.goto(verify_url, timeout=NAV_TIMEOUT)
    await asyncio.sleep(3)
    await _wait_for_cloudflare(page, timeout_s=20)

    # Check for Arkose/FunCaptcha challenge and solve it
    await _solve_arkose_if_present(page)

    # Enter the code
    try:
        code_input = await page.wait_for_selector(
            'input[name*="verification_code"], input[name*="code"], '
            'input[type="text"][maxlength="6"], input[data-testid*="code"], '
            'input[id*="code"], input[placeholder*="code" i]',
            timeout=15000
        )
        await code_input.click()
        await asyncio.sleep(0.3)
        await page.keyboard.type(code, delay=50)
        await asyncio.sleep(1)

        # Submit
        submit_btn = await page.query_selector('button[type="submit"], input[type="submit"], button:has-text("Verify")')
        if submit_btn:
            await submit_btn.click()
            await asyncio.sleep(5)

        # Check result
        current_url = page.url
        if "identity_verification" not in current_url:
            _log("Identity verification successful!")
            return {"success": True}
        else:
            return {"success": False, "error": "Verification code was not accepted"}
    except Exception as e:
        return {"success": False, "error": f"Failed to enter verification code: {e}"}


async def _gmail_get_gitlab_code_or_link(page: Any, email: str, password: str, mode: str = "code") -> dict[str, Any]:
    """
    Log into Gmail and find GitLab verification code or confirmation link.
    mode="code": returns {"success": True, "code": "123456"}
    mode="link": navigates to the confirmation link and returns {"success": True}
    """
    _log("Verifying email via Gmail...")

    # Navigate to Gmail directly - if already logged in via OAuth, it'll go to inbox
    await page.goto(
        "https://mail.google.com/mail/u/0/#inbox",
        wait_until="domcontentloaded",
        timeout=NAV_TIMEOUT,
    )
    await asyncio.sleep(5)

    # Check if we're already in Gmail (logged in from OAuth session)
    current_url = page.url
    if "mail.google.com" in current_url:
        _log("Already logged into Gmail (from OAuth session)")
    else:
        # Need to login to Google
        # Wait for CF if present
        await _wait_for_cloudflare(page, timeout_s=15)

        # Fill email
        try:
            email_input = await page.wait_for_selector('#identifierId, input[type="email"]', timeout=10000)
            await email_input.click()
            await asyncio.sleep(0.3)
            await page.keyboard.type(email, delay=random.randint(30, 60))
            await asyncio.sleep(1)

            # Click Next
            next_btn = await page.query_selector('#identifierNext button, #identifierNext')
            if next_btn:
                await next_btn.click()
            await asyncio.sleep(4)
        except Exception as e:
            # Check if we ended up in Gmail anyway
            if "mail.google.com" in page.url:
                _log("Redirected to Gmail during login")
            else:
                return {"success": False, "error": f"Gmail email step failed: {e}"}

    # Fill password (only if not already in Gmail)
    if "mail.google.com" not in page.url:
        try:
            # Wait for visible password input (Gmail has hidden ones too)
            pass_input = await page.wait_for_selector('input[type="password"][name="Passwd"], input[type="password"]:not([aria-hidden="true"]):not([tabindex="-1"])', timeout=15000)
            if not await pass_input.is_visible():
                # Fallback: find the visible one manually
                all_pass = await page.query_selector_all('input[type="password"]')
                pass_input = None
                for p in all_pass:
                    if await p.is_visible():
                        pass_input = p
                        break
            if not pass_input:
                return {"success": False, "error": "Gmail: no visible password field found"}
            await pass_input.click()
            await asyncio.sleep(0.3)
            await page.keyboard.type(password, delay=random.randint(30, 60))
            await asyncio.sleep(1)

            next_btn2 = await page.query_selector('#passwordNext button, #passwordNext')
            if next_btn2:
                await next_btn2.click()
            await asyncio.sleep(8)
        except Exception as e:
            if "mail.google.com" not in page.url:
                return {"success": False, "error": f"Gmail password step failed: {e}"}

    # Check if we're in the inbox
    current_url = page.url
    if "mail.google.com" not in current_url and "inbox" not in current_url:
        _log(f"Gmail login may have failed. URL: {current_url}")
        return {"success": False, "error": f"Gmail login did not reach inbox. URL: {current_url}"}

    _log("Gmail inbox reached, searching for GitLab confirmation email...")
    await asyncio.sleep(3)

    # Dismiss any Gmail welcome/onboarding modals
    for dismiss_sel in ['button:has-text("Get started")', 'button:has-text("Got it")', 'button:has-text("No thanks")', 'button[aria-label="Close"]']:
        try:
            btn = await page.query_selector(dismiss_sel)
            if btn and await btn.is_visible():
                await btn.click()
                await asyncio.sleep(1)
        except Exception:
            pass

    # Navigate directly to Gmail search for GitLab confirmation emails
    await page.goto(
        "https://mail.google.com/mail/u/0/#search/from%3Agitlab+confirm+your+email",
        timeout=NAV_TIMEOUT,
    )
    await asyncio.sleep(5)

    # Find the confirmation email and extract the link
    # Strategy: scan page HTML for the confirmation token URL directly,
    # or click the first email in search results
    import re as _re

    for attempt in range(5):
        if attempt > 0:
            _log(f"Retrying email search (attempt {attempt + 1})...")
            await asyncio.sleep(8)
            await page.reload()
            await asyncio.sleep(5)

        # First try: click any visible email row (Gmail uses various structures)
        try:
            # Click the first VISIBLE email in the list
            clicked = False
            for selector in ['table.F cf.wT tr', 'div[role="main"] table tr.zA', 'div[role="main"] tbody tr', 'table tbody tr']:
                rows = await page.query_selector_all(selector)
                for row in rows[:5]:
                    if await row.is_visible():
                        await row.click()
                        await asyncio.sleep(4)
                        clicked = True
                        _log("Clicked email row")
                        break
                if clicked:
                    break

            if not clicked:
                continue

            # Now we should be inside the email - look for confirmation link or code
            content = await page.content()

            # Mode "code": look for 6-digit verification code
            if mode == "code":
                codes = _re.findall(r'\b(\d{6})\b', content)
                # Filter out common non-code numbers (years, etc)
                codes = [c for c in codes if not c.startswith("20") and c != "000000"]
                if codes:
                    _log(f"Found verification code: {codes[0]}")
                    return {"success": True, "code": codes[0]}

            # Mode "link": look for confirmation link
            # GitLab confirmation links look like:
            # https://gitlab.com/users/confirmation?confirmation_token=XXXXX
            links = _re.findall(
                r'https://gitlab\.com/users/confirmation\?confirmation_token=[A-Za-z0-9_\-]+',
                content
            )
            if links:
                if mode == "link":
                    confirm_url = links[0]
                    _log(f"Found confirmation link: {confirm_url[:80]}...")
                    await page.goto(confirm_url, timeout=NAV_TIMEOUT)
                    await asyncio.sleep(3)
                    await _wait_for_cloudflare(page, timeout_s=15)
                    _log("Email confirmed!")
                    return {"success": True}
                else:
                    # For code mode, the link itself might contain what we need
                    pass

            # Also try finding a clickable "Confirm your account" button/link
            confirm_btn = await page.query_selector('a:has-text("Confirm your account"), a:has-text("Confirm your email")')
            if confirm_btn and mode == "link":
                href = await confirm_btn.get_attribute("href")
                if href and "confirmation" in href:
                    _log(f"Found confirm button with href: {href[:80]}...")
                    await page.goto(href, timeout=NAV_TIMEOUT)
                    await asyncio.sleep(3)
                    await _wait_for_cloudflare(page, timeout_s=15)
                    _log("Email confirmed!")
                    return {"success": True}

            # Go back to search results for next attempt
            await page.go_back()
            await asyncio.sleep(2)

        except Exception as e:
            _log(f"Attempt {attempt + 1} error: {e}")
            continue

    return {"success": False, "error": "Could not find GitLab confirmation link in emails after retries"}


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
    Perform GitLab signup via Google OAuth.
    This skips email verification entirely since Google verifies the email.
    Returns: {"success": True} or {"success": False, "error": "..."}
    """
    _log("Signing up via Google OAuth...")

    # Navigate to GitLab sign-in page (has Google OAuth button)
    await page.goto(GITLAB_SIGNIN_URL, wait_until="domcontentloaded", timeout=NAV_TIMEOUT)
    await asyncio.sleep(2)

    # Wait for Cloudflare
    cf_passed = await _wait_for_cloudflare(page, timeout_s=30)
    if not cf_passed:
        return {"success": False, "error": "Cloudflare challenge did not resolve on sign-in page"}

    # Click "Sign up" link to go to registration, or find Google button directly
    # GitLab sign-in page has OAuth buttons at the bottom
    google_btn = await page.query_selector(
        'a[href*="google_oauth2"], '
        'button:has-text("Google"), '
        'a:has-text("Google"), '
        'span:has-text("Google")'
    )

    if not google_btn:
        # Try the register page which also has OAuth
        await page.goto(GITLAB_SIGNUP_URL, wait_until="domcontentloaded", timeout=NAV_TIMEOUT)
        await asyncio.sleep(2)
        await _wait_for_cloudflare(page, timeout_s=20)
        google_btn = await page.query_selector(
            'a[href*="google_oauth2"], '
            'button:has-text("Google"), '
            'a:has-text("Google"), '
            'span:has-text("Google")'
        )

    if not google_btn:
        return {"success": False, "error": "Could not find Google OAuth button on GitLab"}

    _log("Clicking Google OAuth button...")
    await google_btn.click()
    await asyncio.sleep(5)

    # Now we're on Google's OAuth consent/login page
    # Fill Google email
    try:
        email_input = await page.wait_for_selector(
            '#identifierId, input[type="email"]', timeout=15000
        )
        await email_input.click()
        await asyncio.sleep(0.3)
        await page.keyboard.type(email, delay=random.randint(30, 60))
        await asyncio.sleep(1)

        # Click Next
        next_btn = await page.query_selector('#identifierNext button, #identifierNext')
        if next_btn:
            await next_btn.click()
        await asyncio.sleep(5)
    except Exception as e:
        # Maybe already logged into Google from a previous session
        current_url = page.url
        if "gitlab.com" in current_url:
            _log("Already authenticated with Google, redirected back to GitLab")
            return await _check_oauth_result(page)
        return {"success": False, "error": f"Google OAuth email step failed: {e}"}

    # Fill Google password
    try:
        # Wait for visible password input
        all_pass = await page.query_selector_all('input[type="password"]')
        pass_input = None
        for _ in range(10):
            for p in all_pass:
                if await p.is_visible():
                    pass_input = p
                    break
            if pass_input:
                break
            await asyncio.sleep(1)
            all_pass = await page.query_selector_all('input[type="password"]')

        if not pass_input:
            # Try wait_for_selector as fallback
            pass_input = await page.wait_for_selector(
                'input[name="Passwd"]:visible, input[type="password"]:visible', timeout=10000
            )

        if not pass_input:
            return {"success": False, "error": "Google OAuth: no visible password field"}

        await pass_input.click()
        await asyncio.sleep(0.3)
        await page.keyboard.type(password, delay=random.randint(30, 60))
        await asyncio.sleep(1)

        next_btn2 = await page.query_selector('#passwordNext button, #passwordNext')
        if next_btn2:
            await next_btn2.click()
        await asyncio.sleep(8)
    except Exception as e:
        current_url = page.url
        if "gitlab.com" in current_url:
            _log("Redirected to GitLab after password")
            return await _check_oauth_result(page)
        return {"success": False, "error": f"Google OAuth password step failed: {e}"}

    # Handle potential Google consent screen ("Allow GitLab to access...")
    await asyncio.sleep(3)
    try:
        allow_btn = await page.query_selector(
            'button:has-text("Allow"), button:has-text("Continue"), '
            'button[id="submit_approve_access"], div[id="submit_approve_access"]'
        )
        if allow_btn and await allow_btn.is_visible():
            _log("Clicking Google consent 'Allow' button...")
            await allow_btn.click()
            await asyncio.sleep(5)
    except Exception:
        pass

    # Should be redirected back to GitLab now
    await asyncio.sleep(3)
    return await _check_oauth_result(page)


async def _check_oauth_result(page: Any) -> dict[str, Any]:
    """Check the result after Google OAuth redirect back to GitLab."""
    # Wait for redirect from Google back to GitLab (up to 15s)
    for _ in range(15):
        current_url = page.url
        if "gitlab.com" in current_url:
            break
        await asyncio.sleep(1)

    current_url = page.url
    content = await page.content()
    content_lower = content.lower()

    # Wait for CF if needed
    await _wait_for_cloudflare(page, timeout_s=15)
    current_url = page.url

    # Success: redirected to dashboard/welcome/projects
    if any(x in current_url for x in ["dashboard", "welcome", "projects", "/-/"]):
        _log("Google OAuth signup successful - logged into GitLab!")
        return {"success": True, "needs_verification": False}

    # Identity verification page - GitLab sends a code to email
    if "identity_verification" in current_url:
        _log("GitLab identity verification required (email code)")
        return {"success": True, "needs_verification": True, "message": "Identity verification - need email code"}

    # GitLab might ask to set username for new OAuth accounts
    username_field = await page.query_selector('#user_username, input[name="user[username]"]')
    if username_field:
        _log("GitLab asking for username (new OAuth account)...")
        username = _derive_username(page.url.split("@")[0] if "@" in page.url else "user")
        try:
            await username_field.fill(username)
            await asyncio.sleep(1)
            submit = await page.query_selector('input[type="submit"], button[type="submit"]')
            if submit:
                await submit.click()
                await asyncio.sleep(5)
            _log(f"Set username to: {username}")
            return {"success": True, "needs_verification": False, "username": username}
        except Exception as e:
            return {"success": False, "error": f"Failed to set username: {e}"}

    # Check for errors
    if "already been taken" in content_lower or "already registered" in content_lower:
        return {"success": False, "error": "Email already registered on GitLab", "already_registered": True}

    if "sign_in" in current_url:
        # Still on sign-in page - OAuth might have failed
        _log(f"Still on sign-in page after OAuth. URL: {current_url}")
        return {"success": False, "error": "Google OAuth did not complete - still on sign-in page"}

    _log(f"OAuth result unclear. URL: {current_url}")
    return {"success": True, "needs_verification": False}


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
                    _log("Email already registered - skipping to login via OAuth")
                elif signup_result.get("rate_limited"):
                    last_error = signup_result["error"]
                    await _cleanup_browser(session)
                    session = None
                    continue  # Retry
                elif signup_result.get("captcha"):
                    return {"success": False, "error": signup_result["error"]}
                else:
                    # Signup failed (CF, network, etc) - retry
                    last_error = signup_result["error"]
                    _log(f"Signup failed: {last_error} - retrying...")
                    await _cleanup_browser(session)
                    session = None
                    continue

            # If verification is needed, try to verify via Gmail
            if signup_result.get("needs_verification"):
                _log("Identity verification required - fetching code from Gmail...")
                verify_result = await _verify_identity_code(page, email, password)
                if not verify_result["success"]:
                    return {
                        "success": False,
                        "error": f"Identity verification failed: {verify_result['error']}",
                        "needs_verification": True,
                        "username": signup_result.get("username", ""),
                    }
                _log("Identity verified! Already logged in via OAuth, skipping login step...")

            # After OAuth we should be logged in - no need for email/password login
            # Just verify we're on a GitLab page (not stuck on Google)
            current_url = page.url
            login_result = {"success": True}
            if "sign_in" in current_url and "gitlab.com" in current_url:
                # Still on sign-in page - try OAuth login (click Google button again)
                _log("Still on sign-in page, retrying Google OAuth...")
                await _cleanup_browser(session)
                session = None
                last_error = "OAuth did not complete login"
                continue

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
