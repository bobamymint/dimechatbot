// Central place to tweak branding without hunting through components.
// Swap these once you have the real Dime (by KKP) brand assets —
// the colors below are a placeholder minimal fintech palette
// (deep navy + gold), set in tailwind.config.ts as `brand` / `accent`.
export const siteConfig = {
  name: "Dime",
  tagline: "Ask me anything about Dime.",
  // Shown when the bot has no relevant knowledge for a question.
  fallbackMessage:
    "I don't have information about that yet. Try asking something else, or let the team know so it can be added to my knowledge base.",
};
