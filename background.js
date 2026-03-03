let scrapeSessions = {};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const tabId = request.sourceTabId || sender?.tab?.id || 'unknown';

    if (request.action === "start_scrape") {
        if (scrapeSessions[tabId] && scrapeSessions[tabId].isScraping) {
            sendResponse({ status: "already_running" });
            return;
        }
        
        scrapeSessions[tabId] = {
            isScraping: true,
            shouldStop: false,
            scrapedData: [],
            totalLinks: request.links.length,
            currentCount: 0
        };

        startScraping(request.links, tabId);
        sendResponse({ status: "started" });
    } 
    else if (request.action === "stop_scrape") {
        if (scrapeSessions[tabId]) {
            scrapeSessions[tabId].shouldStop = true;
        }
        sendResponse({ status: "stopped" });
    }
    else if (request.action === "get_status") {
        const session = scrapeSessions[tabId];
        if (session) {
            sendResponse({
                isScraping: session.isScraping,
                count: session.currentCount,
                total: session.totalLinks,
                wasStopped: session.shouldStop
            });
        } else {
            sendResponse({ isScraping: false });
        }
    }
});

async function startScraping(links, tabId) {
    const session = scrapeSessions[tabId];
    const CONCURRENCY_LIMIT = 5;
    let index = 0;
    let activePromises = [];

    async function processNext() {
        if (shouldStop || index >= links.length) return;

        const currentIndex = index++;
        const link = links[currentIndex];

        try {
            const newTab = await chrome.tabs.create({ url: link, active: false });
            
            // Wait for page to load with an interruptible promise
            let listener;
            await new Promise(resolve => {
                let checkStopInterval = setInterval(() => {
                    if (shouldStop) {
                        clearInterval(checkStopInterval);
                        clearTimeout(timeout);
                        chrome.tabs.onUpdated.removeListener(listener);
                        resolve();
                    }
                }, 500);

                let timeout = setTimeout(() => {
                    clearInterval(checkStopInterval);
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve(); 
                }, 15000); 
                
                listener = function(tabId, info) {
                    if (tabId === newTab.id && info.status === 'complete') {
                        clearInterval(checkStopInterval);
                        clearTimeout(timeout);
                        chrome.tabs.onUpdated.removeListener(listener);
                        setTimeout(() => { resolve(); }, 1500);
                    }
                };
                chrome.tabs.onUpdated.addListener(listener);
            });

            if (shouldStop) {
                try { await chrome.tabs.remove(newTab.id); } catch(err) {}
                return;
            }

            // Verify tab still exists before injecting
            let tabExists = false;
            try {
                const existingTab = await chrome.tabs.get(newTab.id);
                if (existingTab) tabExists = true;
            } catch (err) {
                tabExists = false;
            }

            if (tabExists) {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: newTab.id },
                    func: extractDataFromLivePage
                });

                if (results && results[0] && results[0].result) {
                    const data = results[0].result;
                    data.listingUrl = link;
                    session.scrapedData.push(data);
                }
            }

            try { await chrome.tabs.remove(newTab.id); } catch(err) {}
            session.currentCount++;
            
            if (!shouldStop) {
                // Wait before next link unless we are stopping, also interruptible
                await new Promise(resolve => {
                    let waitTime = 0;
                    let waitInterval = setInterval(() => {
                        waitTime += 500;
                        if (shouldStop || waitTime >= 1000) {
                            clearInterval(waitInterval);
                            resolve();
                        }
                    }, 500);
                });

                // Recursively process next item
                await processNext();
            }
        } catch(e) {
            console.error("Error scraping link", link, e);
            session.currentCount++;
            if (!shouldStop) {
                await processNext();
            }
        }
    }

    // Start initial pool of workers
    for (let i = 0; i < CONCURRENCY_LIMIT && i < links.length; i++) {
        activePromises.push(processNext());
    }

    // Wait for all workers to finish
    await Promise.all(activePromises);
    
    // When loop finishes (or is broken via Stop)
    session.isScraping = false;
    downloadData(session.scrapedData);

    // Cleanup session to free memory
    setTimeout(() => {
        delete scrapeSessions[tabId];
    }, 5000);
}

function downloadData(dataArray) {
    if (!dataArray || dataArray.length === 0) return;
    
    const jsonString = JSON.stringify(dataArray, null, 2);
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
                // Heuristic 1: Look for exact texts and traverse up
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
                    // Start from the text node's parent, go up a few levels to capture the sibling/child container
                    // that actually holds the multi-line description text.
                    let container = sellerDescNode.parentElement;
                    for(let i=0; i<5; i++) {
                        if(container && container.parentElement) {
                            container = container.parentElement;
                        }
                    }
                    if (container) {
                        let text = container.innerText || "";
                        // Fallback logic for extraction: find the index of the header, take text after
                        const headers = ["Seller's description", "Description", "About this item"];
                        let foundHeader = "";
                        for (let h of headers) {
                            if (text.toLowerCase().includes(h.toLowerCase())) {
                                foundHeader = h;
                                break;
                            }
                        }

                        if (foundHeader) {
                            const headerRegex = new RegExp(`^.*?${foundHeader}`, 'is');
                            text = text.replace(headerRegex, '');
                        }

                        text = text.replace(/^(Seller's description|Description|About this item)\n?/i, '');
                        text = text.replace(/\n?See less$/i, '');
                        text = text.replace(/\n?See more$/i, '');
                        text = text.replace(/\n?Report$/i, '');

                        // Clean up leading/trailing empty lines
                        text = text.trim();

                        if (text.length > 5) {
                            description = text;
                        }
                    }
                }
            }

            // Heuristic 2: Many modern FB marketplace listings put the description in a specific div next to the title.
            // Let's try to find spans or divs that have a large amount of text and no inner nested elements (or very few),
            // and are not comments. This is a generic fallback.
            if (description === "No Description Found" || description.length < 10) {
                // Look for divs with multiple lines of text or spans
                const allDivs = document.querySelectorAll('div[dir="auto"], span[dir="auto"]');
                let bestDesc = "";
                for (let el of allDivs) {
                    const txt = el.innerText || "";
                    if (txt.length > 30 && !txt.includes("Marketplace") && !txt.includes("Facebook") && !txt.includes("Message")) {
                        // Ensure it's not the title or price container
                        if (txt.includes(title) && txt.length < title.length + 50) continue;

                        // Often description contains line breaks
                        if (txt.length > bestDesc.length) {
                            bestDesc = txt;
                        }
                    }
                }
                if (bestDesc) {
                    // Try to clean up the best guess
                    let text = bestDesc;
                    text = text.replace(/^(Seller's description|Description|About this item)\n?/i, '');
                    text = text.replace(/\n?See less$/i, '');
                    text = text.replace(/\n?See more$/i, '');
                    text = text.replace(/\n?Report$/i, '');
                    description = text.trim();
                }
            }

            if (description === "No Description Found" || description.length < 10) {
                const ogDesc = document.querySelector('meta[property="og:description"]')?.content;
                if (ogDesc) description = ogDesc;
            }

            if (title.includes(" | Facebook")) title = title.split(" | Facebook")[0];

            // Extract "Listed X days ago in Y"
            let listedTime = "Unknown";
            let location = "Unknown";

            const allSpans = document.querySelectorAll('span, div');
            for (let el of allSpans) {
                const txt = el.innerText || "";
                if (txt.includes("Listed") && txt.includes("ago in")) {
                    // Typical string: "Listed 6 days ago in Sacramento, CA"
                    const match = txt.match(/Listed (.*?) ago in (.*)/i);
                    if (match && match.length >= 3) {
                        listedTime = match[1].trim() + " ago";
                        location = match[2].trim();
                        break;
                    }
                } else if (txt.includes("Listed") && txt.includes("ago")) {
                    // Typical string: "Listed 6 days ago"
                    const match = txt.match(/Listed (.*?) ago/i);
                    if (match && match.length >= 2) {
                        listedTime = match[1].trim() + " ago";
                        break; // Keep looking for location separately? This is a fallback
                    }
                }
            }

            // Fallback for location if not found in the "Listed..." string
            if (location === "Unknown") {
                for (let el of allSpans) {
                    const txt = el.innerText || "";
                    // Sometimes location is just a city, state format in a distinct span. We can try to look for comma formats.
                    // This is risky, but FB often puts the location right under the title/price.
                    if (txt.match(/^[A-Z][a-zA-Z\s]+,\s[A-Z]{2}$/)) {
                        location = txt;
                        break;
                    }
                }
            }

            resolve({ productName: title, price: price, description: description, listedTime: listedTime, location: location });
        }, 2500); 
    });
}
