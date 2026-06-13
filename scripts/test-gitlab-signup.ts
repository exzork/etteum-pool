/**
 * Test script for GitLab Duo signup flow.
 * Run with: bun scripts/test-gitlab-signup.ts
 */
import { launchOptions } from "camoufox-js";
import { firefox, type Page } from "playwright-core";

const EMAIL = "exzork.a.1@guzeil.com";
const PASSWORD = "qwertyui";

async function waitForCF(page: Page, maxWait = 60000): Promise<boolean> {
  const start = Date.now();
  let clicked = false;
  
  while (Date.now() - start < maxWait) {
    // Try clicking CF frame
    for (const frame of page.frames()) {
      if (frame.url().includes("challenges.cloudflare")) {
        if (!clicked) {
          try {
            const body = await frame.$("body");
            if (body) {
              await body.click();
              clicked = true;
              console.log("  [CF] Clicked turnstile frame");
            }
          } catch {}
        }
      }
    }
    
    // Check if passed
    const content = await page.textContent("body").catch(() => "");
    if (content && !content.includes("security verification") && 
        !content.includes("verifikasi") && !content.includes("安全验证") &&
        !content.includes("Just a moment")) {
      // Double check - look for actual page content
      if (content.includes("Sign in") || content.includes("Google") || 
          content.includes("GitLab") || content.length > 500) {
        return true;
      }
    }
    
    await page.waitForTimeout(1500);
  }
  return false;
}

async function main() {
  console.log("=== GitLab Duo Signup Test ===");
  console.log(`Email: ${EMAIL}`);
  
  const opts = await launchOptions({
    headless: true,
    os: "windows",
    humanize: true,
    geoip: true,
    disable_coop: true,
    i_know_what_im_doing: true,
    enable_cache: true,
    proxy: {
      server: "http://gw.dataimpulse.com:10510",
      username: "80ffed31bec173fd6bfa__cr.id,sg",
      password: "aed7edec2dd32529",
    },
    virtual_display: ":99",
  });

  const profileDir = `/tmp/gitlab-test-${Date.now()}`;
  const context = await firefox.launchPersistentContext(profileDir, {
    ...opts,
    viewport: { width: 1366, height: 768 },
  });
  context.on("weberror", () => {});
  
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    // Step 1: GitLab sign-in
    console.log("\n[1/8] Navigating to GitLab sign-in...");
    await page.goto("https://gitlab.com/users/sign_in", { timeout: 60000, waitUntil: "domcontentloaded" });
    
    // Step 2: CF
    console.log("[2/8] Waiting for Cloudflare...");
    const cfOk = await waitForCF(page, 60000);
    if (!cfOk) {
      await page.screenshot({ path: "/tmp/step2-cf-fail.png" });
      throw new Error("CF timeout - screenshot at /tmp/step2-cf-fail.png");
    }
    console.log("  [OK] CF passed");
    await page.screenshot({ path: "/tmp/step2-cf-passed.png" });
    
    // Step 3: Click Google OAuth
    console.log("[3/8] Clicking Google OAuth...");
    await page.waitForTimeout(1000);
    
    // Try multiple selectors
    let googleBtn = await page.$('a[href*="google_oauth2"]');
    if (!googleBtn) googleBtn = await page.$('span:has-text("Google")');
    if (!googleBtn) googleBtn = await page.$('[data-testid="google-login-button"]');
    if (!googleBtn) {
      // Maybe the page has a different layout - screenshot and check
      await page.screenshot({ path: "/tmp/step3-no-google.png" });
      // Try scrolling down
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
      googleBtn = await page.$('a[href*="google_oauth2"]');
    }
    
    if (!googleBtn) {
      throw new Error("Google OAuth button not found - screenshot at /tmp/step3-no-google.png");
    }
    
    await googleBtn.click();
    await page.waitForTimeout(6000);
    console.log(`  [OK] Redirected to: ${page.url().substring(0, 80)}`);
    await page.screenshot({ path: "/tmp/step3-google-redirect.png" });
    
    // Step 4: Google email
    console.log("[4/8] Google login - email...");
    
    // Check if we're on Google's page
    if (!page.url().includes("accounts.google.com")) {
      // Maybe CF on Google's redirect
      await waitForCF(page, 15000);
    }
    
    // Wait for email input or account chooser
    await page.waitForTimeout(2000);
    let emailInput = await page.$('input[type="email"]');
    
    if (!emailInput) {
      // Maybe account chooser - look for "Use another account"
      const useAnother = await page.$('div:has-text("Use another account")');
      if (useAnother) {
        await useAnother.click();
        await page.waitForTimeout(3000);
        emailInput = await page.$('input[type="email"]');
      }
    }
    
    if (!emailInput) {
      await page.screenshot({ path: "/tmp/step4-no-email.png" });
      throw new Error("No email input found - screenshot at /tmp/step4-no-email.png");
    }
    
    await emailInput.fill(EMAIL);
    await page.waitForTimeout(500);
    
    // Click Next
    const nextBtn = await page.$("#identifierNext") || await page.$('button:has-text("Next")') || await page.$('button:has-text("Berikutnya")');
    if (nextBtn) await nextBtn.click();
    await page.waitForTimeout(4000);
    console.log(`  [OK] Email submitted`);
    await page.screenshot({ path: "/tmp/step4-after-email.png" });
    
    // Step 5: Google password
    console.log("[5/8] Google login - password...");
    await page.waitForTimeout(2000);
    
    // Find visible password input
    let pwField: any = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const pwInputs = await page.$$('input[type="password"]');
      for (const inp of pwInputs) {
        if (await inp.isVisible().catch(() => false)) {
          pwField = inp;
          break;
        }
      }
      if (pwField) break;
      await page.waitForTimeout(2000);
    }
    
    if (!pwField) {
      await page.screenshot({ path: "/tmp/step5-no-pw.png" });
      throw new Error("No visible password field - screenshot at /tmp/step5-no-pw.png");
    }
    
    await pwField.fill(PASSWORD);
    await page.waitForTimeout(500);
    
    const pwNext = await page.$("#passwordNext") || await page.$('button:has-text("Next")') || await page.$('button:has-text("Berikutnya")');
    if (pwNext) await pwNext.click();
    await page.waitForTimeout(6000);
    console.log(`  [OK] Password submitted, URL: ${page.url().substring(0, 80)}`);
    await page.screenshot({ path: "/tmp/step5-after-pw.png" });
    
    // Step 6: Consent screen
    console.log("[6/8] Checking consent...");
    await page.waitForTimeout(2000);
    
    for (const sel of ['button:has-text("Continue")', 'button:has-text("Allow")', 'button:has-text("Lanjutkan")', 'button:has-text("Izinkan")']) {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible().catch(() => false)) {
        console.log(`  Clicking: ${sel}`);
        await btn.click();
        await page.waitForTimeout(4000);
        break;
      }
    }
    console.log(`  URL: ${page.url().substring(0, 80)}`);
    await page.screenshot({ path: "/tmp/step6-consent.png" });
    
    // Step 7: Wait for GitLab redirect + handle CF
    console.log("[7/8] Waiting for GitLab...");
    for (let i = 0; i < 20; i++) {
      if (page.url().includes("gitlab.com")) break;
      await page.waitForTimeout(1500);
    }
    
    if (page.url().includes("gitlab.com")) {
      // Handle CF again
      await waitForCF(page, 30000);
    }
    
    console.log(`  URL: ${page.url()}`);
    await page.screenshot({ path: "/tmp/step7-gitlab.png" });
    
    // Step 8: Check result
    console.log("[8/8] Checking result...");
    const finalUrl = page.url();
    const bodyText = await page.textContent("body").catch(() => "");
    
    if (finalUrl.includes("identity_verification")) {
      console.log("  → Identity verification required");
      console.log("  Body preview:", bodyText?.substring(0, 200));
    } else if (finalUrl.includes("gitlab.com") && !finalUrl.includes("sign_in")) {
      console.log("  → Logged in! Dashboard or profile page");
    } else {
      console.log("  → Unknown state");
      console.log("  Body preview:", bodyText?.substring(0, 200));
    }
    
    await page.screenshot({ path: "/tmp/step8-final.png" });
    console.log("\n=== DONE ===");
    
  } catch (e: any) {
    console.error(`\nERROR: ${e.message}`);
    await page.screenshot({ path: "/tmp/error-final.png" }).catch(() => {});
  } finally {
    await context.close();
  }
}

main();
