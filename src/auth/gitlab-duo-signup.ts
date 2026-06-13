/**
 * GitLab Duo account signup automation using camoufox-js + Playwright.
 * 
 * Flow:
 * 1. Launch Camoufox with residential proxy + disable_coop
 * 2. Navigate to GitLab sign-in → click Google OAuth
 * 3. Google login (email + password)
 * 4. Handle identity verification (6-digit code from Gmail + Arkose)
 * 5. Create PAT with api scope
 * 6. Return PAT
 * 
 * Uses Playwright's frame API to handle CF turnstile (cross-origin iframe).
 */

import { launchOptions } from "camoufox-js";
import { firefox, type BrowserContext, type Page, type Frame } from "playwright-core";
import { getNextProxy } from "../services/proxy-pool";
import { config } from "../config";
import { addAuthLog } from "./logs";
import { broadcast } from "../ws/index";

const GITLAB_SIGNIN_URL = "https://gitlab.com/users/sign_in";
const GITLAB_PAT_URL = "https://gitlab.com/-/user_settings/personal_access_tokens";
const PAGE_TIMEOUT = 30_000;
const NAV_TIMEOUT = 60_000;
const CF_WAIT_TIMEOUT = 45_000;

interface SignupResult {
  success: boolean;
  pat?: string;
  error?: string;
}

interface SignupOptions {
  email: string;
  password: string;
  accountId: number;
  headless?: boolean;
}

/**
 * Wait for Cloudflare challenge to resolve.
 * Handles both auto-resolve and interactive turnstile checkbox.
 */
async function waitForCloudflare(page: Page, timeout = CF_WAIT_TIMEOUT): Promise<boolean> {
  const start = Date.now();
  
  while (Date.now() - start < timeout) {
    const url = page.url();
    const title = await page.title().catch(() => "");
    
    // Check if we're past CF
    if (!title.toLowerCase().includes("just a moment") &&
        !title.toLowerCase().includes("performing security") &&
        !title.toLowerCase().includes("verifikasi") &&
        !title.toLowerCase().includes("安全验证") &&
        !url.includes("__cf_chl_rt_tk")) {
      // Check page content doesn't have CF challenge markers
      const content = await page.textContent("body").catch(() => "");
      if (!content?.includes("Performing security verification") &&
          !content?.includes("Melakukan verifikasi") &&
          !content?.includes("正在进行安全验证")) {
        return true;
      }
    }
    
    // Try to find and click the turnstile checkbox in frames
    const frames = page.frames();
    for (const frame of frames) {
      const frameUrl = frame.url();
      if (frameUrl.includes("challenges.cloudflare.com") || frameUrl.includes("turnstile")) {
        try {
          // Try clicking the checkbox body in the CF frame
          const checkbox = await frame.$("body");
          if (checkbox) {
            await checkbox.click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(2000);
          }
        } catch {}
      }
    }
    
    // Also try clicking by coordinates where the checkbox typically appears
    // (center of the turnstile widget area)
    try {
      await page.mouse.click(290, 330);
    } catch {}
    
    await page.waitForTimeout(2000);
  }
  
  return false;
}

/**
 * Handle Google OAuth login flow.
 */
async function googleOAuthLogin(page: Page, email: string, password: string): Promise<boolean> {
  // Wait for Google login page
  await page.waitForURL(/accounts\.google\.com/, { timeout: 15000 }).catch(() => {});
  
  if (!page.url().includes("accounts.google.com")) {
    return false;
  }
  
  // Enter email
  const emailInput = await page.waitForSelector('input[type="email"]', { timeout: 10000 });
  await emailInput.fill(email);
  await page.click('#identifierNext, button:has-text("Next")');
  await page.waitForTimeout(3000);
  
  // Enter password - find the VISIBLE password input (Gmail has a hidden one)
  const passwordInputs = await page.$$('input[type="password"]');
  let passwordField = null;
  for (const input of passwordInputs) {
    if (await input.isVisible()) {
      passwordField = input;
      break;
    }
  }
  
  if (!passwordField) {
    // Try waiting for it
    passwordField = await page.waitForSelector('input[name="Passwd"]:visible, input[type="password"]:visible', { timeout: 10000 });
  }
  
  await passwordField.fill(password);
  await page.click('#passwordNext, button:has-text("Next")');
  await page.waitForTimeout(5000);
  
  // Handle consent screen if it appears
  const allowBtn = await page.$('button:has-text("Allow"), button:has-text("Continue"), button:has-text("Izinkan")');
  if (allowBtn && await allowBtn.isVisible()) {
    await allowBtn.click();
    await page.waitForTimeout(3000);
  }
  
  // Wait for redirect back to GitLab
  for (let i = 0; i < 20; i++) {
    if (page.url().includes("gitlab.com")) return true;
    await page.waitForTimeout(1000);
  }
  
  return page.url().includes("gitlab.com");
}

/**
 * Handle GitLab identity verification page.
 * Requires: 6-digit code from email + Arkose challenge.
 */
async function handleIdentityVerification(page: Page, email: string, password: string): Promise<boolean> {
  if (!page.url().includes("identity_verification")) return true;
  
  // Wait for the verification code input
  const codeInput = await page.waitForSelector('input[data-testid="verification-code-input"], input[name="verification_code"], input[placeholder*="code"]', { timeout: 10000 }).catch(() => null);
  
  if (!codeInput) return false;
  
  // Get the 6-digit code from Gmail
  const code = await getVerificationCodeFromGmail(page, email, password);
  if (!code) return false;
  
  // Navigate back to identity verification page
  await page.goto("https://gitlab.com/users/identity_verification", { timeout: NAV_TIMEOUT });
  await page.waitForTimeout(2000);
  
  // Enter the code
  const input = await page.$('input[data-testid="verification-code-input"], input[name="verification_code"], input[placeholder*="code"]');
  if (input) {
    await input.fill(code);
  }
  
  // Handle Arkose challenge if present
  await handleArkoseChallenge(page);
  
  // Submit
  const submitBtn = await page.$('button[type="submit"], button:has-text("Verify"), button:has-text("Verifikasi")');
  if (submitBtn) {
    await submitBtn.click();
    await page.waitForTimeout(5000);
  }
  
  return !page.url().includes("identity_verification");
}

/**
 * Get verification code from Gmail.
 */
async function getVerificationCodeFromGmail(page: Page, email: string, password: string): Promise<string | null> {
  // Open Gmail in a new tab
  const context = page.context();
  const gmailPage = await context.newPage();
  
  try {
    await gmailPage.goto("https://mail.google.com/mail/u/0/#search/from%3Agitlab+verification+code", { timeout: NAV_TIMEOUT });
    await gmailPage.waitForTimeout(5000);
    
    // If not logged in, the OAuth flow already authenticated us
    // Gmail should be accessible since we just did Google OAuth
    
    // Dismiss any "Welcome" popups
    for (const sel of ['button:has-text("Get started")', 'button:has-text("Got it")', 'button:has-text("No thanks")']) {
      const btn = await gmailPage.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        await gmailPage.waitForTimeout(1000);
      }
    }
    
    // Wait for search results and click first email
    await gmailPage.waitForTimeout(3000);
    const rows = await gmailPage.$$('tr[role="row"], table.F tr, tbody tr');
    if (rows.length > 0) {
      await rows[0].click();
      await gmailPage.waitForTimeout(3000);
    }
    
    // Extract 6-digit code from email content
    const content = await gmailPage.textContent("body") || "";
    const codeMatch = content.match(/\b(\d{6})\b/);
    
    return codeMatch ? codeMatch[1] : null;
  } finally {
    await gmailPage.close();
  }
}

/**
 * Handle Arkose Labs FunCaptcha challenge via 2captcha.
 */
async function handleArkoseChallenge(page: Page): Promise<void> {
  const arkoseKey = "12D76D4C-5EDF-4EB4-A84D-042C497A9610";
  const captchaApiKey = config.captchaApiKey;
  
  if (!captchaApiKey) return;
  
  // Check if Arkose is present
  const arkoseInput = await page.$('input[name="arkose_labs_token"]');
  if (!arkoseInput) return;
  
  // Submit to 2captcha
  const createUrl = `https://2captcha.com/in.php?key=${captchaApiKey}&method=funcaptcha&publickey=${arkoseKey}&pageurl=https://gitlab.com/users/identity_verification&surl=https://gitlab-api.arkoselabs.com&json=1`;
  
  const createResp = await fetch(createUrl);
  const createData = await createResp.json() as any;
  
  if (createData.status !== 1) return;
  
  const taskId = createData.request;
  
  // Poll for solution
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(5000);
    const resultUrl = `https://2captcha.com/res.php?key=${captchaApiKey}&action=get&id=${taskId}&json=1`;
    const resultResp = await fetch(resultUrl);
    const resultData = await resultResp.json() as any;
    
    if (resultData.status === 1) {
      // Inject the token
      await page.evaluate((token: string) => {
        const input = document.querySelector('input[name="arkose_labs_token"]') as HTMLInputElement;
        if (input) input.value = token;
        // Also try the callback
        if ((window as any).arkoseCallback) {
          (window as any).arkoseCallback({ token });
        }
      }, resultData.request);
      return;
    }
    
    if (resultData.request !== "CAPCHA_NOT_READY") return;
  }
}

/**
 * Create a Personal Access Token on GitLab.
 */
async function createPAT(page: Page): Promise<string | null> {
  await page.goto(GITLAB_PAT_URL, { timeout: NAV_TIMEOUT });
  await waitForCloudflare(page, 30000);
  await page.waitForTimeout(3000);
  
  // Check if we're on the PAT page
  if (!page.url().includes("personal_access_tokens")) {
    return null;
  }
  
  // Fill in PAT form
  const nameInput = await page.$('input[id="personal_access_token_name"], input[name="personal_access_token[name]"]');
  if (!nameInput) return null;
  
  const tokenName = `duo-pool-${Date.now()}`;
  await nameInput.fill(tokenName);
  
  // Set expiry to max (1 year from now)
  const expiryInput = await page.$('input[id="personal_access_token_expires_at"], input[name="personal_access_token[expires_at]"]');
  if (expiryInput) {
    const expiry = new Date();
    expiry.setFullYear(expiry.getFullYear() + 1);
    await expiryInput.fill(expiry.toISOString().split("T")[0]);
  }
  
  // Select 'api' scope
  const apiScope = await page.$('input[id="personal_access_token_scopes_api"], input[value="api"]');
  if (apiScope) {
    await apiScope.check();
  }
  
  // Submit
  const submitBtn = await page.$('input[type="submit"], button[type="submit"], button:has-text("Create personal access token")');
  if (submitBtn) {
    await submitBtn.click();
    await page.waitForTimeout(5000);
  }
  
  // Extract the generated token
  const tokenEl = await page.$('input[id="created-personal-access-token"], input[name="created-personal-access-token"], #created-personal-access-token, [data-testid="clipboard-button"]');
  if (tokenEl) {
    const token = await tokenEl.getAttribute("value") || await tokenEl.inputValue().catch(() => "");
    if (token && token.startsWith("glpat-")) {
      return token;
    }
  }
  
  // Try to find it in the page content
  const pageContent = await page.textContent("body") || "";
  const patMatch = pageContent.match(/glpat-[A-Za-z0-9_-]{20,}/);
  return patMatch ? patMatch[0] : null;
}

/**
 * Main signup function — launches Camoufox and drives the full flow.
 */
export async function signupGitLabDuo(options: SignupOptions): Promise<SignupResult> {
  const { email, password, accountId, headless = true } = options;
  
  // Get a residential proxy
  const proxy = await getNextProxy("auth");
  if (!proxy) {
    return { success: false, error: "No proxy available" };
  }
  
  // Parse proxy URL
  const proxyUrl = new URL(proxy.url);
  const proxyConfig = {
    server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
    username: decodeURIComponent(proxyUrl.username),
    password: decodeURIComponent(proxyUrl.password),
  };
  
  const log = (step: string, message: string) => {
    addAuthLog({ type: "login_progress", accountId, email, provider: "gitlab-duo", step, message });
    broadcast({ type: "login_progress", data: { id: accountId, email, provider: "gitlab-duo", step, message } });
  };
  
  let context: BrowserContext | null = null;
  
  try {
    log("launching", "Launching Camoufox browser...");
    
    // Get camoufox launch options
    const opts = await launchOptions({
      headless: headless,
      os: "windows",
      humanize: true,
      geoip: true,
      disable_coop: true,
      i_know_what_im_doing: true,
      enable_cache: true,
      proxy: proxyConfig,
      virtual_display: headless ? ":99" : undefined,
    });
    
    // Launch persistent context
    const profileDir = `/tmp/gitlab-duo-${accountId}-${Date.now()}`;
    context = await firefox.launchPersistentContext(profileDir, {
      ...opts,
      viewport: { width: 1366, height: 768 },
      acceptDownloads: false,
    });
    
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT);
    
    // Step 1: Navigate to GitLab sign-in
    log("navigating", "Navigating to GitLab sign-in...");
    await page.goto(GITLAB_SIGNIN_URL, { timeout: NAV_TIMEOUT });
    
    // Step 2: Handle Cloudflare
    log("cloudflare", "Waiting for Cloudflare challenge...");
    const cfPassed = await waitForCloudflare(page);
    if (!cfPassed) {
      return { success: false, error: "Cloudflare challenge timeout" };
    }
    log("cloudflare_passed", "Cloudflare challenge resolved");
    
    // Step 3: Click Google OAuth button
    log("oauth", "Clicking Google OAuth button...");
    const googleBtn = await page.$('a[href*="google_oauth2"], a:has-text("Google"), span:has-text("Google"), [data-testid="google-login-button"]');
    if (!googleBtn) {
      return { success: false, error: "Google OAuth button not found" };
    }
    await googleBtn.click();
    await page.waitForTimeout(3000);
    
    // Step 4: Google login
    log("google_login", "Logging into Google...");
    const oauthSuccess = await googleOAuthLogin(page, email, password);
    if (!oauthSuccess) {
      return { success: false, error: "Google OAuth login failed" };
    }
    log("google_done", "Google OAuth completed");
    
    // Step 5: Handle CF again after redirect
    await waitForCloudflare(page, 20000);
    
    // Step 6: Handle identity verification if needed
    if (page.url().includes("identity_verification")) {
      log("verification", "Handling identity verification...");
      const verified = await handleIdentityVerification(page, email, password);
      if (!verified) {
        return { success: false, error: "Identity verification failed" };
      }
      log("verified", "Identity verification passed");
    }
    
    // Step 7: Create PAT
    log("pat", "Creating Personal Access Token...");
    const pat = await createPAT(page);
    if (!pat) {
      return { success: false, error: "Failed to create PAT" };
    }
    
    log("success", `PAT created successfully: ${pat.substring(0, 10)}...`);
    return { success: true, pat };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log("error", `Signup failed: ${errorMsg}`);
    return { success: false, error: errorMsg };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}
