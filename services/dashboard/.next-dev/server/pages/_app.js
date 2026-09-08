/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
(() => {
var exports = {};
exports.id = "pages/_app";
exports.ids = ["pages/_app"];
exports.modules = {

/***/ "./src/components/Layout.tsx":
/*!***********************************!*\
  !*** ./src/components/Layout.tsx ***!
  \***********************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (/* binding */ Layout)\n/* harmony export */ });\n/* harmony import */ var react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! react/jsx-dev-runtime */ \"react/jsx-dev-runtime\");\n/* harmony import */ var react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__);\n/* harmony import */ var next_link__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! next/link */ \"../../node_modules/next/link.js\");\n/* harmony import */ var next_link__WEBPACK_IMPORTED_MODULE_1___default = /*#__PURE__*/__webpack_require__.n(next_link__WEBPACK_IMPORTED_MODULE_1__);\n/* harmony import */ var next_router__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! next/router */ \"../../node_modules/next/router.js\");\n/* harmony import */ var next_router__WEBPACK_IMPORTED_MODULE_2___default = /*#__PURE__*/__webpack_require__.n(next_router__WEBPACK_IMPORTED_MODULE_2__);\n\n\n\nconst navigation = [\n    {\n        href: \"/\",\n        label: \"Overview\",\n        icon: \"⌂\"\n    },\n    {\n        href: \"/calendar\",\n        label: \"Content calendar\",\n        icon: \"▦\"\n    },\n    {\n        href: \"/content/new\",\n        label: \"Create content\",\n        icon: \"+\"\n    },\n    {\n        href: \"/queues\",\n        label: \"Queue monitor\",\n        icon: \"◌\"\n    },\n    {\n        href: \"/niches\",\n        label: \"Niche profiles\",\n        icon: \"✦\"\n    },\n    {\n        href: \"/accounts\",\n        label: \"Connected accounts\",\n        icon: \"◎\"\n    },\n    {\n        href: \"/audit\",\n        label: \"Audit history\",\n        icon: \"≡\"\n    },\n    {\n        href: \"/settings\",\n        label: \"Settings\",\n        icon: \"⚙\"\n    }\n];\nfunction Layout({ children }) {\n    const router = (0,next_router__WEBPACK_IMPORTED_MODULE_2__.useRouter)();\n    return /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"div\", {\n        className: \"app-shell\",\n        children: [\n            /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"aside\", {\n                className: \"sidebar\",\n                children: [\n                    /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"div\", {\n                        className: \"brand\",\n                        children: [\n                            /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"span\", {\n                                className: \"brand-mark\",\n                                children: \"VF\"\n                            }, void 0, false, {\n                                fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                                lineNumber: 21,\n                                columnNumber: 32\n                            }, this),\n                            /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"div\", {\n                                children: [\n                                    /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"strong\", {\n                                        children: \"ViralForge\"\n                                    }, void 0, false, {\n                                        fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                                        lineNumber: 21,\n                                        columnNumber: 75\n                                    }, this),\n                                    /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"small\", {\n                                        children: \"Creator operations\"\n                                    }, void 0, false, {\n                                        fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                                        lineNumber: 21,\n                                        columnNumber: 102\n                                    }, this)\n                                ]\n                            }, void 0, true, {\n                                fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                                lineNumber: 21,\n                                columnNumber: 70\n                            }, this)\n                        ]\n                    }, void 0, true, {\n                        fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                        lineNumber: 21,\n                        columnNumber: 9\n                    }, this),\n                    /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"nav\", {\n                        className: \"nav-list\",\n                        children: navigation.map((item)=>/*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)((next_link__WEBPACK_IMPORTED_MODULE_1___default()), {\n                                href: item.href,\n                                className: `nav-item ${router.pathname === item.href || item.href !== \"/\" && router.pathname.startsWith(item.href) ? \"active\" : \"\"}`,\n                                children: [\n                                    /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"span\", {\n                                        children: item.icon\n                                    }, void 0, false, {\n                                        fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                                        lineNumber: 23,\n                                        columnNumber: 212\n                                    }, this),\n                                    item.label\n                                ]\n                            }, item.href, true, {\n                                fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                                lineNumber: 23,\n                                columnNumber: 37\n                            }, this))\n                    }, void 0, false, {\n                        fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                        lineNumber: 22,\n                        columnNumber: 9\n                    }, this),\n                    /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"div\", {\n                        className: \"sidebar-note\",\n                        children: [\n                            /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"span\", {\n                                className: \"live-dot\"\n                            }, void 0, false, {\n                                fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                                lineNumber: 25,\n                                columnNumber: 39\n                            }, this),\n                            \" Local safe mode\",\n                            /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"br\", {}, void 0, false, {\n                                fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                                lineNumber: 25,\n                                columnNumber: 84\n                            }, this),\n                            /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"small\", {\n                                children: \"Publishing is protected\"\n                            }, void 0, false, {\n                                fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                                lineNumber: 25,\n                                columnNumber: 90\n                            }, this)\n                        ]\n                    }, void 0, true, {\n                        fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                        lineNumber: 25,\n                        columnNumber: 9\n                    }, this)\n                ]\n            }, void 0, true, {\n                fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                lineNumber: 20,\n                columnNumber: 7\n            }, this),\n            /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"main\", {\n                className: \"main-area\",\n                children: [\n                    /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"header\", {\n                        className: \"topbar\",\n                        children: [\n                            /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"div\", {\n                                children: [\n                                    /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"span\", {\n                                        className: \"eyebrow\",\n                                        children: \"VIRALFORGE STUDIO\"\n                                    }, void 0, false, {\n                                        fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                                        lineNumber: 28,\n                                        columnNumber: 41\n                                    }, this),\n                                    /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"h1\", {\n                                        children: navigation.find((item)=>item.href === router.pathname || item.href !== \"/\" && router.pathname.startsWith(item.href))?.label || \"Overview\"\n                                    }, void 0, false, {\n                                        fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                                        lineNumber: 28,\n                                        columnNumber: 91\n                                    }, this)\n                                ]\n                            }, void 0, true, {\n                                fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                                lineNumber: 28,\n                                columnNumber: 36\n                            }, this),\n                            /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"div\", {\n                                className: \"topbar-actions\",\n                                children: [\n                                    /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"span\", {\n                                        className: \"safe-badge\",\n                                        children: \"● Publishing disabled\"\n                                    }, void 0, false, {\n                                        fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                                        lineNumber: 28,\n                                        columnNumber: 281\n                                    }, this),\n                                    /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)((next_link__WEBPACK_IMPORTED_MODULE_1___default()), {\n                                        className: \"button primary\",\n                                        href: \"/content/new\",\n                                        children: \"＋ New content\"\n                                    }, void 0, false, {\n                                        fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                                        lineNumber: 28,\n                                        columnNumber: 338\n                                    }, this)\n                                ]\n                            }, void 0, true, {\n                                fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                                lineNumber: 28,\n                                columnNumber: 249\n                            }, this)\n                        ]\n                    }, void 0, true, {\n                        fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                        lineNumber: 28,\n                        columnNumber: 9\n                    }, this),\n                    /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(\"div\", {\n                        className: \"page-content\",\n                        children: children\n                    }, void 0, false, {\n                        fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                        lineNumber: 29,\n                        columnNumber: 9\n                    }, this)\n                ]\n            }, void 0, true, {\n                fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n                lineNumber: 27,\n                columnNumber: 7\n            }, this)\n        ]\n    }, void 0, true, {\n        fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\components\\\\Layout.tsx\",\n        lineNumber: 19,\n        columnNumber: 5\n    }, this);\n}\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiLi9zcmMvY29tcG9uZW50cy9MYXlvdXQudHN4IiwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7O0FBQTZCO0FBQ1c7QUFHeEMsTUFBTUUsYUFBYTtJQUNqQjtRQUFFQyxNQUFNO1FBQUtDLE9BQU87UUFBWUMsTUFBTTtJQUFJO0lBQzFDO1FBQUVGLE1BQU07UUFBYUMsT0FBTztRQUFvQkMsTUFBTTtJQUFJO0lBQzFEO1FBQUVGLE1BQU07UUFBZ0JDLE9BQU87UUFBa0JDLE1BQU07SUFBSTtJQUMzRDtRQUFFRixNQUFNO1FBQVdDLE9BQU87UUFBaUJDLE1BQU07SUFBSTtJQUNyRDtRQUFFRixNQUFNO1FBQVdDLE9BQU87UUFBa0JDLE1BQU07SUFBSTtJQUN0RDtRQUFFRixNQUFNO1FBQWFDLE9BQU87UUFBc0JDLE1BQU07SUFBSTtJQUM1RDtRQUFFRixNQUFNO1FBQVVDLE9BQU87UUFBaUJDLE1BQU07SUFBSTtJQUNwRDtRQUFFRixNQUFNO1FBQWFDLE9BQU87UUFBWUMsTUFBTTtJQUFJO0NBQ25EO0FBRWMsU0FBU0MsT0FBTyxFQUFFQyxRQUFRLEVBQTJCO0lBQ2xFLE1BQU1DLFNBQVNQLHNEQUFTQTtJQUN4QixxQkFDRSw4REFBQ1E7UUFBSUMsV0FBVTs7MEJBQ2IsOERBQUNDO2dCQUFNRCxXQUFVOztrQ0FDZiw4REFBQ0Q7d0JBQUlDLFdBQVU7OzBDQUFRLDhEQUFDRTtnQ0FBS0YsV0FBVTswQ0FBYTs7Ozs7OzBDQUFTLDhEQUFDRDs7a0RBQUksOERBQUNJO2tEQUFPOzs7Ozs7a0RBQW1CLDhEQUFDQztrREFBTTs7Ozs7Ozs7Ozs7Ozs7Ozs7O2tDQUNwRyw4REFBQ0M7d0JBQUlMLFdBQVU7a0NBQ1pSLFdBQVdjLEdBQUcsQ0FBQyxDQUFDQyxxQkFBUyw4REFBQ2pCLGtEQUFJQTtnQ0FBaUJHLE1BQU1jLEtBQUtkLElBQUk7Z0NBQUVPLFdBQVcsQ0FBQyxTQUFTLEVBQUVGLE9BQU9VLFFBQVEsS0FBS0QsS0FBS2QsSUFBSSxJQUFLYyxLQUFLZCxJQUFJLEtBQUssT0FBT0ssT0FBT1UsUUFBUSxDQUFDQyxVQUFVLENBQUNGLEtBQUtkLElBQUksSUFBSyxXQUFXLEdBQUcsQ0FBQzs7a0RBQUUsOERBQUNTO2tEQUFNSyxLQUFLWixJQUFJOzs7Ozs7b0NBQVNZLEtBQUtiLEtBQUs7OytCQUF2TWEsS0FBS2QsSUFBSTs7Ozs7Ozs7OztrQ0FFaEQsOERBQUNNO3dCQUFJQyxXQUFVOzswQ0FBZSw4REFBQ0U7Z0NBQUtGLFdBQVU7Ozs7Ozs0QkFBYTswQ0FBZ0IsOERBQUNVOzs7OzswQ0FBSyw4REFBQ047MENBQU07Ozs7Ozs7Ozs7Ozs7Ozs7OzswQkFFMUYsOERBQUNPO2dCQUFLWCxXQUFVOztrQ0FDZCw4REFBQ1k7d0JBQU9aLFdBQVU7OzBDQUFTLDhEQUFDRDs7a0RBQUksOERBQUNHO3dDQUFLRixXQUFVO2tEQUFVOzs7Ozs7a0RBQXdCLDhEQUFDYTtrREFBSXJCLFdBQVdzQixJQUFJLENBQUMsQ0FBQ1AsT0FBU0EsS0FBS2QsSUFBSSxLQUFLSyxPQUFPVSxRQUFRLElBQUtELEtBQUtkLElBQUksS0FBSyxPQUFPSyxPQUFPVSxRQUFRLENBQUNDLFVBQVUsQ0FBQ0YsS0FBS2QsSUFBSSxJQUFLQyxTQUFTOzs7Ozs7Ozs7Ozs7MENBQXNCLDhEQUFDSztnQ0FBSUMsV0FBVTs7a0RBQWlCLDhEQUFDRTt3Q0FBS0YsV0FBVTtrREFBYTs7Ozs7O2tEQUE0Qiw4REFBQ1Ysa0RBQUlBO3dDQUFDVSxXQUFVO3dDQUFpQlAsTUFBSztrREFBZTs7Ozs7Ozs7Ozs7Ozs7Ozs7O2tDQUM5WCw4REFBQ007d0JBQUlDLFdBQVU7a0NBQWdCSDs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBSXZDIiwic291cmNlcyI6WyJ3ZWJwYWNrOi8vQHZpcmFsZm9yZ2UvZGFzaGJvYXJkLy4vc3JjL2NvbXBvbmVudHMvTGF5b3V0LnRzeD9kZThiIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBMaW5rIGZyb20gJ25leHQvbGluayc7XG5pbXBvcnQgeyB1c2VSb3V0ZXIgfSBmcm9tICduZXh0L3JvdXRlcic7XG5pbXBvcnQgeyBSZWFjdE5vZGUgfSBmcm9tICdyZWFjdCc7XG5cbmNvbnN0IG5hdmlnYXRpb24gPSBbXG4gIHsgaHJlZjogJy8nLCBsYWJlbDogJ092ZXJ2aWV3JywgaWNvbjogJ+KMgicgfSxcbiAgeyBocmVmOiAnL2NhbGVuZGFyJywgbGFiZWw6ICdDb250ZW50IGNhbGVuZGFyJywgaWNvbjogJ+KWpicgfSxcbiAgeyBocmVmOiAnL2NvbnRlbnQvbmV3JywgbGFiZWw6ICdDcmVhdGUgY29udGVudCcsIGljb246ICcrJyB9LFxuICB7IGhyZWY6ICcvcXVldWVzJywgbGFiZWw6ICdRdWV1ZSBtb25pdG9yJywgaWNvbjogJ+KXjCcgfSxcbiAgeyBocmVmOiAnL25pY2hlcycsIGxhYmVsOiAnTmljaGUgcHJvZmlsZXMnLCBpY29uOiAn4pymJyB9LFxuICB7IGhyZWY6ICcvYWNjb3VudHMnLCBsYWJlbDogJ0Nvbm5lY3RlZCBhY2NvdW50cycsIGljb246ICfil44nIH0sXG4gIHsgaHJlZjogJy9hdWRpdCcsIGxhYmVsOiAnQXVkaXQgaGlzdG9yeScsIGljb246ICfiiaEnIH0sXG4gIHsgaHJlZjogJy9zZXR0aW5ncycsIGxhYmVsOiAnU2V0dGluZ3MnLCBpY29uOiAn4pqZJyB9LFxuXTtcblxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gTGF5b3V0KHsgY2hpbGRyZW4gfTogeyBjaGlsZHJlbjogUmVhY3ROb2RlIH0pIHtcbiAgY29uc3Qgcm91dGVyID0gdXNlUm91dGVyKCk7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzc05hbWU9XCJhcHAtc2hlbGxcIj5cbiAgICAgIDxhc2lkZSBjbGFzc05hbWU9XCJzaWRlYmFyXCI+XG4gICAgICAgIDxkaXYgY2xhc3NOYW1lPVwiYnJhbmRcIj48c3BhbiBjbGFzc05hbWU9XCJicmFuZC1tYXJrXCI+VkY8L3NwYW4+PGRpdj48c3Ryb25nPlZpcmFsRm9yZ2U8L3N0cm9uZz48c21hbGw+Q3JlYXRvciBvcGVyYXRpb25zPC9zbWFsbD48L2Rpdj48L2Rpdj5cbiAgICAgICAgPG5hdiBjbGFzc05hbWU9XCJuYXYtbGlzdFwiPlxuICAgICAgICAgIHtuYXZpZ2F0aW9uLm1hcCgoaXRlbSkgPT4gPExpbmsga2V5PXtpdGVtLmhyZWZ9IGhyZWY9e2l0ZW0uaHJlZn0gY2xhc3NOYW1lPXtgbmF2LWl0ZW0gJHtyb3V0ZXIucGF0aG5hbWUgPT09IGl0ZW0uaHJlZiB8fCAoaXRlbS5ocmVmICE9PSAnLycgJiYgcm91dGVyLnBhdGhuYW1lLnN0YXJ0c1dpdGgoaXRlbS5ocmVmKSkgPyAnYWN0aXZlJyA6ICcnfWB9PjxzcGFuPntpdGVtLmljb259PC9zcGFuPntpdGVtLmxhYmVsfTwvTGluaz4pfVxuICAgICAgICA8L25hdj5cbiAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJzaWRlYmFyLW5vdGVcIj48c3BhbiBjbGFzc05hbWU9XCJsaXZlLWRvdFwiIC8+IExvY2FsIHNhZmUgbW9kZTxiciAvPjxzbWFsbD5QdWJsaXNoaW5nIGlzIHByb3RlY3RlZDwvc21hbGw+PC9kaXY+XG4gICAgICA8L2FzaWRlPlxuICAgICAgPG1haW4gY2xhc3NOYW1lPVwibWFpbi1hcmVhXCI+XG4gICAgICAgIDxoZWFkZXIgY2xhc3NOYW1lPVwidG9wYmFyXCI+PGRpdj48c3BhbiBjbGFzc05hbWU9XCJleWVicm93XCI+VklSQUxGT1JHRSBTVFVESU88L3NwYW4+PGgxPntuYXZpZ2F0aW9uLmZpbmQoKGl0ZW0pID0+IGl0ZW0uaHJlZiA9PT0gcm91dGVyLnBhdGhuYW1lIHx8IChpdGVtLmhyZWYgIT09ICcvJyAmJiByb3V0ZXIucGF0aG5hbWUuc3RhcnRzV2l0aChpdGVtLmhyZWYpKSk/LmxhYmVsIHx8ICdPdmVydmlldyd9PC9oMT48L2Rpdj48ZGl2IGNsYXNzTmFtZT1cInRvcGJhci1hY3Rpb25zXCI+PHNwYW4gY2xhc3NOYW1lPVwic2FmZS1iYWRnZVwiPuKXjyBQdWJsaXNoaW5nIGRpc2FibGVkPC9zcGFuPjxMaW5rIGNsYXNzTmFtZT1cImJ1dHRvbiBwcmltYXJ5XCIgaHJlZj1cIi9jb250ZW50L25ld1wiPu+8iyBOZXcgY29udGVudDwvTGluaz48L2Rpdj48L2hlYWRlcj5cbiAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJwYWdlLWNvbnRlbnRcIj57Y2hpbGRyZW59PC9kaXY+XG4gICAgICA8L21haW4+XG4gICAgPC9kaXY+XG4gICk7XG59XG4iXSwibmFtZXMiOlsiTGluayIsInVzZVJvdXRlciIsIm5hdmlnYXRpb24iLCJocmVmIiwibGFiZWwiLCJpY29uIiwiTGF5b3V0IiwiY2hpbGRyZW4iLCJyb3V0ZXIiLCJkaXYiLCJjbGFzc05hbWUiLCJhc2lkZSIsInNwYW4iLCJzdHJvbmciLCJzbWFsbCIsIm5hdiIsIm1hcCIsIml0ZW0iLCJwYXRobmFtZSIsInN0YXJ0c1dpdGgiLCJiciIsIm1haW4iLCJoZWFkZXIiLCJoMSIsImZpbmQiXSwic291cmNlUm9vdCI6IiJ9\n//# sourceURL=webpack-internal:///./src/components/Layout.tsx\n");

/***/ }),

/***/ "./src/pages/_app.tsx":
/*!****************************!*\
  !*** ./src/pages/_app.tsx ***!
  \****************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (/* binding */ App)\n/* harmony export */ });\n/* harmony import */ var react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! react/jsx-dev-runtime */ \"react/jsx-dev-runtime\");\n/* harmony import */ var react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__);\n/* harmony import */ var _components_Layout__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../components/Layout */ \"./src/components/Layout.tsx\");\n/* harmony import */ var _styles_globals_css__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../styles/globals.css */ \"./src/styles/globals.css\");\n/* harmony import */ var _styles_globals_css__WEBPACK_IMPORTED_MODULE_2___default = /*#__PURE__*/__webpack_require__.n(_styles_globals_css__WEBPACK_IMPORTED_MODULE_2__);\n\n\n\nfunction App({ Component, pageProps }) {\n    return /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(_components_Layout__WEBPACK_IMPORTED_MODULE_1__[\"default\"], {\n        children: /*#__PURE__*/ (0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)(Component, {\n            ...pageProps\n        }, void 0, false, {\n            fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\pages\\\\_app.tsx\",\n            lineNumber: 6,\n            columnNumber: 18\n        }, this)\n    }, void 0, false, {\n        fileName: \"D:\\\\contentAutomation\\\\services\\\\dashboard\\\\src\\\\pages\\\\_app.tsx\",\n        lineNumber: 6,\n        columnNumber: 10\n    }, this);\n}\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiLi9zcmMvcGFnZXMvX2FwcC50c3giLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7OztBQUMwQztBQUNYO0FBRWhCLFNBQVNDLElBQUksRUFBRUMsU0FBUyxFQUFFQyxTQUFTLEVBQVk7SUFDNUQscUJBQU8sOERBQUNILDBEQUFNQTtrQkFBQyw0RUFBQ0U7WUFBVyxHQUFHQyxTQUFTOzs7Ozs7Ozs7OztBQUN6QyIsInNvdXJjZXMiOlsid2VicGFjazovL0B2aXJhbGZvcmdlL2Rhc2hib2FyZC8uL3NyYy9wYWdlcy9fYXBwLnRzeD9mOWQ2Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgQXBwUHJvcHMgfSBmcm9tICduZXh0L2FwcCc7XG5pbXBvcnQgTGF5b3V0IGZyb20gJy4uL2NvbXBvbmVudHMvTGF5b3V0JztcbmltcG9ydCAnLi4vc3R5bGVzL2dsb2JhbHMuY3NzJztcblxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gQXBwKHsgQ29tcG9uZW50LCBwYWdlUHJvcHMgfTogQXBwUHJvcHMpIHtcbiAgcmV0dXJuIDxMYXlvdXQ+PENvbXBvbmVudCB7Li4ucGFnZVByb3BzfSAvPjwvTGF5b3V0Pjtcbn1cbiJdLCJuYW1lcyI6WyJMYXlvdXQiLCJBcHAiLCJDb21wb25lbnQiLCJwYWdlUHJvcHMiXSwic291cmNlUm9vdCI6IiJ9\n//# sourceURL=webpack-internal:///./src/pages/_app.tsx\n");

/***/ }),

/***/ "./src/styles/globals.css":
/*!********************************!*\
  !*** ./src/styles/globals.css ***!
  \********************************/
/***/ (() => {



/***/ }),

/***/ "next/dist/compiled/next-server/pages.runtime.dev.js":
/*!**********************************************************************!*\
  !*** external "next/dist/compiled/next-server/pages.runtime.dev.js" ***!
  \**********************************************************************/
/***/ ((module) => {

"use strict";
module.exports = require("next/dist/compiled/next-server/pages.runtime.dev.js");

/***/ }),

/***/ "react":
/*!************************!*\
  !*** external "react" ***!
  \************************/
/***/ ((module) => {

"use strict";
module.exports = require("react");

/***/ }),

/***/ "react-dom":
/*!****************************!*\
  !*** external "react-dom" ***!
  \****************************/
/***/ ((module) => {

"use strict";
module.exports = require("react-dom");

/***/ }),

/***/ "react/jsx-dev-runtime":
/*!****************************************!*\
  !*** external "react/jsx-dev-runtime" ***!
  \****************************************/
/***/ ((module) => {

"use strict";
module.exports = require("react/jsx-dev-runtime");

/***/ }),

/***/ "react/jsx-runtime":
/*!************************************!*\
  !*** external "react/jsx-runtime" ***!
  \************************************/
/***/ ((module) => {

"use strict";
module.exports = require("react/jsx-runtime");

/***/ }),

/***/ "fs":
/*!*********************!*\
  !*** external "fs" ***!
  \*********************/
/***/ ((module) => {

"use strict";
module.exports = require("fs");

/***/ }),

/***/ "stream":
/*!*************************!*\
  !*** external "stream" ***!
  \*************************/
/***/ ((module) => {

"use strict";
module.exports = require("stream");

/***/ }),

/***/ "zlib":
/*!***********************!*\
  !*** external "zlib" ***!
  \***********************/
/***/ ((module) => {

"use strict";
module.exports = require("zlib");

/***/ })

};
;

// load runtime
var __webpack_require__ = require("../webpack-runtime.js");
__webpack_require__.C(exports);
var __webpack_exec__ = (moduleId) => (__webpack_require__(__webpack_require__.s = moduleId))
var __webpack_exports__ = __webpack_require__.X(0, ["vendor-chunks/next","vendor-chunks/@swc"], () => (__webpack_exec__("./src/pages/_app.tsx")));
module.exports = __webpack_exports__;

})();