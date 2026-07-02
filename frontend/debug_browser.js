import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  page.on('console', msg => console.log(`Browser Console [${msg.type()}]: ${msg.text()}`));
  page.on('pageerror', error => console.log(`Browser Error: ${error.message}`));

  console.log("Navigating to localhost:5173...");
  await page.goto('http://localhost:5173/');

  console.log("Typing repo url...");
  await page.fill("input[type='text']", "https://github.com/shivprasad08/Briefly");
  await page.click("button[type='submit']");

  console.log("Waiting for analyze to complete (up to 60s)...");
  try {
    await page.waitForSelector(".force-graph-container", { timeout: 60000 });
    console.log("Graph loaded.");
  } catch (e) {
    console.log("Timeout waiting for graph.");
  }
  
  await new Promise(r => setTimeout(r, 2000));
  await browser.close();
})();
