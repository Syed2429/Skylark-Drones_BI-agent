import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#08090d',
          900: '#0d0f14',
          850: '#12141b',
          800: '#181b24',
          700: '#232733',
          600: '#333846',
        },
      },
    },
  },
  plugins: [],
};

export default config;
