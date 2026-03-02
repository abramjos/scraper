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

            // Send URLs to the background worker
            chrome.runtime.sendMessage({ action: "start_scrape", links: links }, (response) => {
                if (response && response.status === "started") {
                    statusDiv.innerHTML = `<span class="success">✅ Found ${links.length} items.</span><br><br><b>Scraping has started!</b><br>You can safely close this popup or browse other tabs.`;
                    startBtn.style.display = "none";
                    stopBtn.style.display = "block";
                    startPolling();
                } else if (response && response.status === "already_running") {
                    statusDiv.innerText = "A scrape is already in progress!";
                }
            });

        } catch (error) {
            statusDiv.innerText = `Error: ${error.message}`;
            startBtn.disabled = false;
        }
    });

    // -- STOP LOGIC --
    stopBtn.addEventListener('click', () => {
        stopBtn.disabled = true;
        stopBtn.innerText = "Stopping (Please wait)...";
        chrome.runtime.sendMessage({ action: "stop_scrape" }, (response) => {
            if (response && response.status === "stopped") {
                statusDiv.innerHTML = `<span class="stopped">🛑 Stopping after current item finishes...</span>`;
            }
        });
    });

    function startPolling() {
        if (pollInterval) clearInterval(pollInterval);
        pollInterval = setInterval(checkStatus, 1000);
    }

    function checkStatus() {
        chrome.runtime.sendMessage({ action: "get_status" }, (response) => {
            if (response && response.isScraping) {
                startBtn.style.display = "none";
                stopBtn.style.display = "block";
                progressContainer.style.display = "block";
                
                scrapeProgress.max = response.total;
                scrapeProgress.value = response.count;
                progressText.innerText = `${response.count} / ${response.total} items scraped`;
                
                if (statusDiv.innerText === "Ready to scan current tab.") {
                    statusDiv.innerHTML = `<span class="success">Scraping is actively running!</span><br><br><b>You can close this popup.</b> The JSON will auto-save.`;
                }

                if (!pollInterval) startPolling();
            } else {
                // Scraping is finished or was stopped
                if (pollInterval) {
                    clearInterval(pollInterval);
                    pollInterval = null;
                    progressContainer.style.display = "none";
                    
                    if (response && response.wasStopped) {
                        statusDiv.innerHTML = `<span class="stopped">🛑 Scrape stopped early.</span><br>Partial data auto-saved to Downloads folder.`;
                    } else {
                        statusDiv.innerHTML = `<span class="success">✅ Scraping Complete!</span><br>File auto-saved to your Downloads folder.`;
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

function extractMarketplaceLinks() {
    const anchors = document.querySelectorAll('a[href*="/marketplace/item/"]');
    const uniqueLinks = new Set();
    
    anchors.forEach(a => {
        try {
            const url = new URL(a.href, window.location.origin);
            url.search = '';
            url.hash = '';
            uniqueLinks.add(url.href);
        } catch (e) { }
    });
    return Array.from(uniqueLinks);
}
