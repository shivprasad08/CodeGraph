import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        # Log all console messages
        page.on("console", lambda msg: print(f"Browser Console [{msg.type}]: {msg.text}"))
        page.on("pageerror", lambda err: print(f"Browser Error: {err.message}"))
        
        print("Navigating to localhost:5173...")
        await page.goto("http://localhost:5173/")
        
        print("Typing repo url...")
        await page.fill("input[type='text']", "https://github.com/shivprasad08/Briefly")
        await page.click("button[type='submit']")
        
        print("Waiting for analyze to complete (up to 30s)...")
        # Wait for the graph canvas to appear or an error to occur
        try:
            await page.wait_for_selector(".force-graph-container", timeout=30000)
            print("Graph loaded.")
        except Exception as e:
            print("Timeout waiting for graph.")
            
        # Give it a few seconds to flush errors
        await asyncio.sleep(2)
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
