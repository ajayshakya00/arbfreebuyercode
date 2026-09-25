// Background service worker for ARB Free Buyer
const api = typeof browser !== "undefined" ? browser : chrome;

if (api && api.runtime && api.runtime.onMessage) {
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "ORDER_PURCHASED") {
      try {
        if (api.notifications && api.notifications.create) {
          api.notifications.create({
            type: "basic",
            iconUrl: "icon128.png",
            title: "🎉 ARB Free Buyer: Order Purchased!",
            message: `Successfully bought order for ₹${msg.amount || "amount"}! Check your payment screen.`,
            priority: 2
          });
        }
      } catch (e) {
        console.warn("Notification error:", e);
      }
    }
  });
}
