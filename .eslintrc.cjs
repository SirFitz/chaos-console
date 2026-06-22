module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module", ecmaFeatures: { jsx: true } },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: { node: true, es2022: true },
  ignorePatterns: ["dist", "node_modules", "coverage"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  },
  overrides: [
    // Web sources run in the browser.
    { files: ["packages/web/**/*.{ts,tsx}"], env: { browser: true, es2022: true } },
    // Tests use `any` for lightweight mock fixtures — pragmatic and isolated from prod code.
    {
      files: ["**/test/**/*.{ts,tsx}", "**/*.test.{ts,tsx}"],
      rules: { "@typescript-eslint/no-explicit-any": "off" },
    },
  ],
};
