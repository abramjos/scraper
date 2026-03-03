document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const statusDiv = document.getElementById('status');
    const progressContainer = document.getElementById('progressContainer');
    const scrapeProgress = document.getElementById('scrapeProgress');
    const progressText = document.getElementById('progressText');

    let pollInterval = null;

    // Check if scraping is already running when popup opens
    checkStatus();

    // -- START LOGIC --
    startBtn.addEventListener('click', async () => {
        startBtn.disabled = true;
        statusDiv.innerText = "Scanning page for Marketplace links...";

        try {
            const[activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!activeTab || (!activeTab.url.includes("facebook.com") && !activeTab.url.includes("messenger.com"))) {
                statusDiv.innerText = "Error: Please navigate to Facebook Marketplace first.";
                startBtn.disabled = false;
                return;
            }

            const injectionResults = await chrome.scripting.executeScript({
                target: { tabId: activeTab.id },
                func: extractMarketplaceLinks
            });

            const links = injectionResults[0]?.result ||[];

            if (links.length === 0) {
                statusDiv.innerText = "No Marketplace item links found on this page.";
                startBtn.disabled = false;
                return;
            }

            // Send URLs and Tab ID to the background worker
            chrome.runtime.sendMessage({ action: "start_scrape", links: links, sourceTabId: activeTab.id }, (response) => {
                if (response && response.status === "started") {
                    statusDiv.innerHTML = `<span class="success">✅ Found ${links.length} items.</span><br><br><b>Scraping has started!</b><br>You can safely close this popup or browse other tabs.`;
                    startBtn.style.display = "none";
                    stopBtn.style.display = "block";
                    startPolling(activeTab.id);
                } else if (response && response.status === "already_running") {
                    statusDiv.innerText = "This tab is already scraping!";
                    startBtn.style.display = "none";
                    stopBtn.style.display = "block";
                    startPolling(activeTab.id);
                }
            });

        } catch (error) {
            statusDiv.innerText = `Error: ${error.message}`;
            startBtn.disabled = false;
        }
    });

    // -- STOP LOGIC --
    stopBtn.addEventListener('click', async () => {
        stopBtn.disabled = true;
        stopBtn.innerText = "Stopping (Please wait)...";
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

        chrome.runtime.sendMessage({ action: "stop_scrape", sourceTabId: activeTab?.id }, (response) => {
            if (response && response.status === "stopped") {
                statusDiv.innerHTML = `<span class="stopped">🛑 Stopping immediately...</span>`;
                setTimeout(() => checkStatus(activeTab?.id), 500);
            }
        });
    });

    function startPolling(tabId) {
        if (pollInterval) clearInterval(pollInterval);
        pollInterval = setInterval(() => checkStatus(tabId), 1000);
    }

    async function checkStatus(tabId) {
        if (!tabId) {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs.length) tabId = tabs[0].id;
        }

        chrome.runtime.sendMessage({ action: "get_status", sourceTabId: tabId }, (response) => {
            if (response && response.isScraping) {
                startBtn.style.display = "none";
                stopBtn.style.display = "block";
                progressContainer.style.display = "block";
                
                scrapeProgress.max = response.total;
                scrapeProgress.value = response.count;
                progressText.innerText = `${response.count} / ${response.total} items scraped`;
                
                if (statusDiv.innerText.includes("Ready to scan")) {
                    statusDiv.innerHTML = `<span class="success">Scraping is actively running!</span><br><br><b>You can close this popup.</b> The JSON will auto-save.`;
                }

                if (!pollInterval) startPolling(tabId);
            } else {
                // Scraping is finished or was stopped
                if (pollInterval) {
                    clearInterval(pollInterval);
                    pollInterval = null;
                    progressContainer.style.display = "none";
                    
                    if (response && response.wasStopped) {
                        statusDiv.innerHTML = `<span class="stopped">🛑 Scrape stopped early.</span><br>Partial data auto-saved to Downloads folder.`;
                    } else if (response && response.total > 0) {
                        statusDiv.innerHTML = `<span class="success">✅ Scraping Complete!</span><br>File auto-saved to your Downloads folder.`;
                    } else {
                        statusDiv.innerHTML = "Ready to scan current tab.";
                    }
                    
                    startBtn.style.display = "block";
                    startBtn.disabled = false;
                    stopBtn.style.display = "none";
                    stopBtn.disabled = false;
                    stopBtn.innerText = "🛑 Stop Scraping";
                }
            }
        });
    }
});

async function extractMarketplaceLinks() {
    const uniqueLinks = new Set();
    let noNewLinksCount = 0;
    
    // Auto-scroll loop to grab up to 100 links
    while (uniqueLinks.size < 100 && noNewLinksCount < 5) {
        const anchors = document.querySelectorAll('a[href*="/marketplace/item/"]');
        const initialSize = uniqueLinks.size;

        anchors.forEach(a => {
            try {
                const url = new URL(a.href, window.location.origin);
                url.search = '';
                url.hash = '';
                if (uniqueLinks.size < 100) {
                    uniqueLinks.add(url.href);
                }
            } catch (e) { }
        });

        if (uniqueLinks.size === initialSize) {
            noNewLinksCount++;
        } else {
            noNewLinksCount = 0;
        }

        if (uniqueLinks.size >= 100) {
            break;
        }

        // Scroll down
        window.scrollBy(0, window.innerHeight);
        // Wait for potential new content to load
        await new Promise(r => setTimeout(r, 1000));
    }

    // Scroll back to top
    window.scrollTo(0, 0);

    return Array.from(uniqueLinks);
}
