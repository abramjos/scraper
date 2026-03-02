let isScraping = false;
let shouldStop = false;
let scrapedData =[];
let totalLinks = 0;
let currentCount = 0;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "start_scrape") {
        if (isScraping) {
            sendResponse({ status: "already_running" });
            return;
        }
        isScraping = true;
        shouldStop = false;
        scrapedData =[];
        totalLinks = request.links.length;
        currentCount = 0;
        
        startScraping(request.links);
        sendResponse({ status: "started" });
    } 
    else if (request.action === "stop_scrape") {
        shouldStop = true;
        sendResponse({ status: "stopped" });
    }
    else if (request.action === "get_status") {
        sendResponse({ isScraping, count: currentCount, total: totalLinks, wasStopped: shouldStop });
    }
});

async function startScraping(links) {
    for (let i = 0; i < links.length; i++) {
        // BREAK OUT OF LOOP IF USER HIT STOP
        if (shouldStop) {
            console.log("Scraping halted by user command.");
            break;
        }

        try {
            const link = links[i];
            const newTab = await chrome.tabs.create({ url: link, active: false });
            
            await new Promise(resolve => {
                let timeout = setTimeout(() => {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve(); 
                }, 15000); 
                
                function listener(tabId, info) {
                    if (tabId === newTab.id && info.status === 'complete') {
                        clearTimeout(timeout);
                        chrome.tabs.onUpdated.removeListener(listener);
                        setTimeout(resolve, 1500); 
                    }
                }
                chrome.tabs.onUpdated.addListener(listener);
            });

            const results = await chrome.scripting.executeScript({
                target: { tabId: newTab.id },
                func: extractDataFromLivePage
            });

            if (results && results[0] && results[0].result) {
                const data = results[0].result;
                data.listingUrl = link;
                scrapedData.push(data);
            }

            await chrome.tabs.remove(newTab.id);
            
            currentCount++;
            
            // Wait before next link unless we are stopping
            if (!shouldStop) {
                await new Promise(r => setTimeout(r, 2000));
            }
            
        } catch(e) {
            console.error("Error scraping link", links[i], e);
            currentCount++; 
        }
    }
    
    // When loop finishes (or is broken via Stop)
    isScraping = false;
    downloadData();
}

function downloadData() {
    if (scrapedData.length === 0) return;
    
    const jsonString = JSON.stringify(scrapedData, null, 2);
    const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(jsonString);
    
    chrome.downloads.download({
        url: dataUrl,
        filename: `fb_marketplace_scrape_${Date.now()}.json`,
        saveAs: false,
        conflictAction: "uniquify"
    });
}

// Injected into Facebook tab
function extractDataFromLivePage() {
    return new Promise((resolve) => {
        setTimeout(async () => {
            const clickableDivs = document.querySelectorAll('div[role="button"]');
            for (let div of clickableDivs) {
                if (/see more/i.test(div.innerText) && div.innerText.length < 20) {
                    try { div.click(); await new Promise(r => setTimeout(r, 800)); } catch (e) {}
                }
            }

            let title = "Unknown Title";
            const h1s = document.querySelectorAll('h1');
            for (let i = h1s.length - 1; i >= 0; i--) {
                const text = h1s[i].textContent.trim();
                if (text && !['Facebook', 'Notifications', 'Marketplace', 'Messages'].includes(text)) {
                    title = text;
                    break;
                }
            }

            let price = "Unknown Price";
            const priceRegex = /^[$€£¥]\s?[\d,]+(\.\d{2})?$/;
            const spans = document.querySelectorAll('span, div');
            for (let span of spans) {
                const txt = span.textContent.trim();
                if (priceRegex.test(txt)) {
                    price = txt;
                    break;
                }
            }

            let description = "No Description Found";

            const schemas = document.querySelectorAll('script[type="application/ld+json"]');
            for (let schema of schemas) {
                try {
                    const data = JSON.parse(schema.innerText);
                    const items = Array.isArray(data) ? data : [data];
                    for (let item of items) {
                        if (item.description) {
                            let tempDiv = document.createElement("div");
                            tempDiv.innerHTML = item.description;
                            description = tempDiv.textContent || tempDiv.innerText || item.description;
                            break;
                        }
                    }
                } catch(e) {}
                if (description !== "No Description Found") break;
            }

            if (description === "No Description Found") {
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
                let sellerDescNode = null;
                while(walker.nextNode()) {
                    const text = walker.currentNode.nodeValue.trim().toLowerCase();
                    if (text === "seller's description" || text === "about this item" || text === "description") {
                        sellerDescNode = walker.currentNode;
                        break;
                    }
                }

                if (sellerDescNode) {
                    let container = sellerDescNode.parentElement;
                    for(let i=0; i<4; i++) {
                        if(container && container.parentElement) container = container.parentElement;
                    }
                    if (container) {
                        let text = container.innerText || "";
                        text = text.replace(/^(Seller's description|Description|About this item)\n?/i, '');
                        text = text.replace(/\nSee less$/i, '');
                        text = text.replace(/\nSee more$/i, '');
                        text = text.replace(/\nReport$/i, '');
                        if (text.trim().length > 5) {
                            description = text.trim();
                        }
                    }
                }
            }

            if (description === "No Description Found" || description.length < 10) {
                const ogDesc = document.querySelector('meta[property="og:description"]')?.content;
                if (ogDesc) description = ogDesc;
            }

            if (title.includes(" | Facebook")) title = title.split(" | Facebook")[0];

            resolve({ productName: title, price: price, description: description });
        }, 2500); 
    });
}
