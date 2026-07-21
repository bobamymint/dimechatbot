import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Placeholder palette inspired by Dime's minimal fintech look:
        // deep navy + warm gold accent. Swap these for the exact brand
        // hex values whenever real brand assets are available.
        ink: {
          950: "#0B0F1A",
          900: "#161C2B",
          800: "#232B40",
        },
        brand: {
          DEFAULT: "#0F1B3D", // deep navy
          50: "#EEF1F8",
          100: "#D9DFEF",
          500: "#0F1B3D",
          600: "#0B1530",
        },
        accent: {
          DEFAULT: "#E8B84B", // dime-gold accent
          50: "#FDF6E7",
          500: "#E8B84B",
          600: "#CB9E36",
        },
      },
      borderRadius: {
        xl2: "1.25rem",
      },
    },
  },
  plugins: [],
};

export default config;
