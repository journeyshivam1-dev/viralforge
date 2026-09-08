self.__BUILD_MANIFEST = {
  "polyfillFiles": [
    "static/chunks/polyfills.js"
  ],
  "devFiles": [
    "static/chunks/react-refresh.js"
  ],
  "ampDevFiles": [],
  "lowPriorityFiles": [],
  "rootMainFiles": [],
  "pages": {
    "/": [
      "static/chunks/webpack.js",
      "static/chunks/main.js",
      "static/chunks/pages/index.js"
    ],
    "/_app": [
      "static/chunks/webpack.js",
      "static/chunks/main.js",
      "static/chunks/pages/_app.js"
    ],
    "/_error": [
      "static/chunks/webpack.js",
      "static/chunks/main.js",
      "static/chunks/pages/_error.js"
    ],
    "/accounts": [
      "static/chunks/webpack.js",
      "static/chunks/main.js",
      "static/chunks/pages/accounts.js"
    ],
    "/audit": [
      "static/chunks/webpack.js",
      "static/chunks/main.js",
      "static/chunks/pages/audit.js"
    ],
    "/calendar": [
      "static/chunks/webpack.js",
      "static/chunks/main.js",
      "static/chunks/pages/calendar.js"
    ],
    "/content/new": [
      "static/chunks/webpack.js",
      "static/chunks/main.js",
      "static/chunks/pages/content/new.js"
    ],
    "/niches": [
      "static/chunks/webpack.js",
      "static/chunks/main.js",
      "static/chunks/pages/niches.js"
    ],
    "/queues": [
      "static/chunks/webpack.js",
      "static/chunks/main.js",
      "static/chunks/pages/queues.js"
    ],
    "/settings": [
      "static/chunks/webpack.js",
      "static/chunks/main.js",
      "static/chunks/pages/settings.js"
    ]
  },
  "ampFirstPages": []
};
self.__BUILD_MANIFEST.lowPriorityFiles = [
"/static/" + process.env.__NEXT_BUILD_ID + "/_buildManifest.js",
,"/static/" + process.env.__NEXT_BUILD_ID + "/_ssgManifest.js",

];