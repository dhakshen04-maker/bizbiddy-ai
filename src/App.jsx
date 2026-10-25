import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { getSupabaseClient, migrateLocalData, readCloudData, saveCloudData, supabaseConfigured, supabasePartiallyConfigured, withTimeout } from "./lib/supabase.js";
import "./App.css";

// Encode Unicode content as UTF-8 bytes for international names and messages.
qrcode.stringToBytes = (value) => Array.from(new TextEncoder().encode(value));

const STORAGE_KEY = "bizbuddy-data";
const CHAT_STORAGE_KEY = "bizbuddy-assistant-chat";
const customerStatuses = ["Lead", "Active", "Inactive"];
const emptyCustomer = { name: "", phone: "", email: "", company: "", notes: "", status: "Lead" };

const emptyBusiness = {
  name: "",
  type: "",
  country: "",
  currency: "USD",
  language: "English",
  phone: "",
  address: "",
  hours: "",
  description: "",
  email: "",
  website: "",
  color: "#1e7546",
};

const emptyPoster = {
  type: "offer",
  template: "modern",
  title: "SPECIAL OFFER",
  subtitle: "Discover our products and services",
  description: "",
  price: "",
  contact: "",
  callToAction: "Shop now",
  backgroundColor: "#1e7546",
  textColor: "#ffffff",
  titleSize: 76,
  bodySize: 28,
  imageData: "",
  imageX: 50,
  imageY: 50,
  imageScale: 44,
};

const initialData = {
  business: emptyBusiness,
  products: [],
  customers: [],
  poster: emptyPoster,
  assistantInstructions: "",
};

function loadChatHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value.slice(-50).filter((message) =>
      message && ["user", "assistant"].includes(message.role) && typeof message.content === "string"
    ).map((message, index) => ({
      id: typeof message.id === "string" ? message.id : `saved-${index}`,
      role: message.role,
      content: message.content.slice(0, 8000),
      createdAt: typeof message.createdAt === "string" ? message.createdAt : "",
    }));
  } catch {
    return [];
  }
}

function localAssistantReply(question, business, products) {
  const normalized = question.toLowerCase();
  const contact = [business.phone && `phone ${business.phone}`, business.email && `email ${business.email}`, business.website && `website ${business.website}`].filter(Boolean).join(", ");
  const followUp = contact ? ` Please contact the business by ${contact}.` : " Please contact the business owner for help.";
  const unavailable = `I don't have that information in the business profile.${followUp}`;

  if (/\b(hours?|open|close|opening|closing)\b/.test(normalized)) {
    return business.hours ? `Business hours: ${business.hours}` : `Business hours are not listed.${followUp}`;
  }
  if (/\b(address|location|located|directions?)\b/.test(normalized)) {
    return business.address ? `Business address: ${business.address}` : `The business address is not listed.${followUp}`;
  }
  if (/\b(contact|phone|call|email|website|whatsapp)\b/.test(normalized)) {
    return contact ? `Available contact details: ${contact}.` : `Contact details are not listed.${followUp}`;
  }
  if (/\b(price|cost|pricing|how much)\b/.test(normalized)) {
    const priced = products.filter((product) => String(product.price || "").trim());
    return priced.length
      ? `Listed prices: ${priced.map((product) => `${product.name}: ${product.price} ${business.currency || ""}`.trim()).join("; ")}.${followUp}`
      : `Product or service prices are not listed.${followUp}`;
  }
  if (/\b(product|products|service|services|offer|sell|catalog)\b/.test(normalized)) {
    const listed = products.map((product) => [product.name, product.description].filter(Boolean).join(": ")).filter(Boolean);
    const serviceInfo = [business.type, business.description].filter(Boolean).join(" — ");
    const facts = [...(serviceInfo ? [serviceInfo] : []), ...listed];
    return facts.length ? `${facts.join("\n")}${followUp}` : `Products and services are not listed.${followUp}`;
  }
  if (/\b(name|who are you|business)\b/.test(normalized) && business.name) {
    return `This is ${business.name}${business.type ? `, a ${business.type} business` : ""}.`;
  }
  return unavailable;
}

function normalizePoster(value) {
  const saved = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const boundedNumber = (name, min, max) => {
    const number = Number(saved[name]);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : emptyPoster[name];
  };
  const safeText = (name, limit) => typeof saved[name] === "string" ? saved[name].slice(0, limit) : emptyPoster[name];
  return {
    ...emptyPoster,
    type: ["offer", "product", "service", "event", "announcement"].includes(saved.type) ? saved.type : emptyPoster.type,
    template: ["modern", "product", "event", "minimal", "bold"].includes(saved.template) ? saved.template : emptyPoster.template,
    title: safeText("title", 100), subtitle: safeText("subtitle", 140),
    description: safeText("description", 240), price: safeText("price", 36),
    contact: safeText("contact", 100), callToAction: safeText("callToAction", 80),
    backgroundColor: typeof saved.backgroundColor === "string" && /^#[\da-f]{6}$/i.test(saved.backgroundColor) ? saved.backgroundColor : emptyPoster.backgroundColor,
    textColor: typeof saved.textColor === "string" && /^#[\da-f]{6}$/i.test(saved.textColor) ? saved.textColor : emptyPoster.textColor,
    titleSize: boundedNumber("titleSize", 30, 92), bodySize: boundedNumber("bodySize", 14, 40),
    imageX: boundedNumber("imageX", 5, 95), imageY: boundedNumber("imageY", 20, 80),
    imageScale: boundedNumber("imageScale", 15, 75),
    imageData: typeof saved.imageData === "string" && saved.imageData.length <= 1_800_000 && /^data:image\/(?:jpeg|png|webp);base64,/i.test(saved.imageData) ? saved.imageData : "",
  };
}

function normalizeCustomer(value, index) {
  const customer = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const text = (key, limit) => typeof customer[key] === "string" ? customer[key].slice(0, limit) : "";
  return {
    id: typeof customer.id === "string" && customer.id ? customer.id : `saved-customer-${index}`,
    name: text("name", 120),
    phone: text("phone", 40),
    email: text("email", 160),
    company: text("company", 120),
    notes: text("notes", 2000),
    status: customerStatuses.includes(customer.status) ? customer.status : "Active",
    createdAt: typeof customer.createdAt === "string" ? customer.createdAt : "",
  };
}

function normalizeProduct(value, index) {
  const product = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const text = (key) => typeof product[key] === "string" ? product[key].slice(0, 100_000) : "";
  return {
    id: typeof product.id === "string" && product.id ? product.id : `saved-product-${index}`,
    name: text("name"),
    price: text("price"),
    description: text("description"),
    url: text("url"),
  };
}

function validateAndNormalizeBackup(value) {
  const fail = (message) => { throw new Error(message); };
  const isRecord = (item) => item && typeof item === "object" && !Array.isArray(item);
  if (!isRecord(value)) fail("This file is not a BizBuddy backup object.");
  if (value.format !== "bizbuddy-ai-backup" || value.version !== 1) fail("This backup format or version is not supported.");
  if (!isRecord(value.business)) fail("The backup is missing a valid business profile.");

  const business = {};
  for (const key of Object.keys(emptyBusiness)) {
    const field = value.business[key];
    if (typeof field !== "string" || field.length > 100_000) fail("The business profile field \"" + key + "\" is missing or invalid.");
    business[key] = field;
  }
  if (!/^#[\da-f]{6}$/i.test(business.color)) fail("The business profile has an invalid brand color.");

  if (!Array.isArray(value.products) || value.products.length > 5000) fail("The product list is missing or exceeds 5,000 records.");
  const products = value.products.map((item, index) => {
    if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 100_000) {
      fail("Product " + (index + 1) + " must have a valid name.");
    }
    for (const key of ["price", "description", "url"]) {
      if (item[key] !== undefined && (typeof item[key] !== "string" || item[key].length > 100_000)) {
        fail("Product " + (index + 1) + " has an invalid " + key + ".");
      }
    }
    return {
      id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
      name: item.name.trim(), price: item.price || "", description: item.description || "", url: item.url || "",
    };
  });

  if (!Array.isArray(value.customers) || value.customers.length > 5000) fail("The customer list is missing or exceeds 5,000 records.");
  const customers = value.customers.map((item, index) => {
    if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 120) {
      fail("Customer " + (index + 1) + " must have a valid name.");
    }
    for (const [key, limit] of [["phone", 40], ["email", 160], ["company", 120], ["notes", 2000]]) {
      if (item[key] !== undefined && (typeof item[key] !== "string" || item[key].length > limit)) {
        fail("Customer " + (index + 1) + " has an invalid " + key + ".");
      }
    }
    if (item.status !== undefined && !customerStatuses.includes(item.status)) fail("Customer " + (index + 1) + " has an unsupported status.");
    return normalizeCustomer(item, index);
  });

  if (value.settings !== undefined && !isRecord(value.settings)) fail("Saved app settings are malformed.");
  const settings = value.settings || {};
  if (settings.assistantInstructions !== undefined &&
      (typeof settings.assistantInstructions !== "string" || settings.assistantInstructions.length > 2000)) {
    fail("Assistant instructions are invalid or too long.");
  }
  if (settings.poster !== undefined) {
    if (!isRecord(settings.poster)) fail("Poster settings are malformed.");
    const poster = settings.poster;
    if (poster.type !== undefined && !["offer", "product", "service", "event", "announcement"].includes(poster.type)) fail("Poster type is invalid.");
    if (poster.template !== undefined && !["modern", "product", "event", "minimal", "bold"].includes(poster.template)) fail("Poster template is invalid.");
    for (const key of ["title", "subtitle", "description", "price", "contact", "callToAction"]) {
      if (poster[key] !== undefined && typeof poster[key] !== "string") fail("Poster " + key + " must be text.");
    }
    for (const key of ["backgroundColor", "textColor"]) {
      if (poster[key] !== undefined && (typeof poster[key] !== "string" || !/^#[\da-f]{6}$/i.test(poster[key]))) fail("Poster " + key + " is invalid.");
    }
    for (const [key, min, max] of [["titleSize", 30, 92], ["bodySize", 14, 40], ["imageX", 5, 95], ["imageY", 20, 80], ["imageScale", 15, 75]]) {
      const number = Number(poster[key]);
      if (poster[key] !== undefined && (!Number.isFinite(number) || number < min || number > max)) {
        fail("Poster " + key + " is outside the supported range.");
      }
    }
    if (poster.imageData !== undefined &&
        (typeof poster.imageData !== "string" || poster.imageData.length > 1_800_000 ||
         (poster.imageData && !/^data:image\/(?:jpeg|png|webp);base64,/i.test(poster.imageData)))) {
      fail("The saved poster image is invalid or too large.");
    }
  }

  const chatHistory = value.chatHistory === undefined ? [] : value.chatHistory;
  if (!Array.isArray(chatHistory) || chatHistory.length > 50 || chatHistory.some((message) =>
    !isRecord(message) || !["user", "assistant"].includes(message.role) ||
    typeof message.content !== "string" || message.content.length > 8000
  )) fail("The saved assistant chat history is malformed.");

  return {
    data: {
      business,
      products,
      customers,
      poster: normalizePoster(settings.poster),
      assistantInstructions: settings.assistantInstructions || "",
    },
    chatHistory: chatHistory.map((message, index) => ({
      id: typeof message.id === "string" ? message.id : "backup-chat-" + index,
      role: message.role,
      content: message.content,
      createdAt: typeof message.createdAt === "string" ? message.createdAt : "",
    })),
  };
}

function normalizeCloudSnapshot(cloud) {
  const restored = validateAndNormalizeBackup({
    format: "bizbuddy-ai-backup",
    version: 1,
    business: cloud.data.business,
    products: cloud.data.products,
    customers: cloud.data.customers,
    settings: { poster: cloud.data.poster, assistantInstructions: cloud.data.assistantInstructions },
    chatHistory: cloud.chatHistory,
  });
  return { ...restored, hasData: cloud.hasData };
}

const currencies = {
  "United States": "USD",
  "United Kingdom": "GBP",
  Canada: "CAD",
  Australia: "AUD",
  India: "INR",
  Germany: "EUR",
  France: "EUR",
  "United Arab Emirates": "AED",
  Singapore: "SGD",
};

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const countries = Array.from({ length: 26 * 26 }, (_, index) => {
  const region = String.fromCharCode(65 + Math.floor(index / 26)) + String.fromCharCode(65 + (index % 26));
  const name = regionNames.of(region);
  return name && name !== region ? { region, name } : null;
}).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));

const languageTags = {
  English: "en", Spanish: "es", French: "fr", German: "de", Hindi: "hi",
  Arabic: "ar", Chinese: "zh", Japanese: "ja", Portuguese: "pt", Bengali: "bn",
  Urdu: "ur", Russian: "ru", Italian: "it", Dutch: "nl", Korean: "ko",
};

const navItems = [
  ["Dashboard", "⌂"],
  ["My Business", "▣"],
  ["Website Builder", "🌐"],
  ["QR Catalog", "▦"],
  ["Poster Maker", "🎨"],
  ["Customer Assistant", "💬"],
  ["Customers", "♙"],
  ["Settings", "⚙"],
];

const dashboardActions = [
  { page: "Website Builder", icon: "▧", title: "Build your website", description: "Create a page for your business." },
  { page: "QR Catalog", icon: "▦", title: "Share your catalog", description: "Add products and make QR codes." },
  { page: "Poster Maker", icon: "▤", title: "Design a poster", description: "Create a promotion to download." },
  { page: "Customer Assistant", icon: "✦", title: "Set up your assistant", description: "Answer questions with your business details." },
];

const escapeHTML = (value = "") =>
  String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);

function safeWebsiteURL(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function loadData() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return initialData;

    const parsed = JSON.parse(stored);

    return {
      business: { ...emptyBusiness, ...parsed.business },
      // localStorage can contain stale or hand-edited records; never let a null
      // product crash the render path that maps the catalog on every page.
      products: Array.isArray(parsed.products)
        ? parsed.products.map(normalizeProduct).filter((product) => product.name.trim())
        : [],
      customers: Array.isArray(parsed.customers) ? parsed.customers.map(normalizeCustomer) : [],
      poster: normalizePoster(parsed.poster),
      assistantInstructions: typeof parsed.assistantInstructions === "string" ? parsed.assistantInstructions.slice(0, 2000) : "",
    };
  } catch {
    return initialData;
  }
}

function saveData(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

function posterValue(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function wrapPosterText(context, text, maxWidth, maxLines) {
  const lines = [];
  let line = "";
  for (const word of String(text || "").trim().split(/\s+/)) {
    if (!word) continue;
    let segment = "";
    for (const character of word) {
      if (context.measureText(segment + character).width > maxWidth && segment) {
        if (line) { lines.push(line); line = ""; }
        lines.push(segment);
        segment = character;
      } else segment += character;
    }
    const candidate = line ? `${line} ${segment}` : segment;
    if (context.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = segment;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

async function drawPosterCanvas(canvas, poster, business, width, height, isCurrent = () => true) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  canvas.width = width;
  canvas.height = height;
  context.setTransform(width / 1200, 0, 0, height / 1500, 0, 0);

  const background = /^#[\da-f]{6}$/i.test(poster.backgroundColor) ? poster.backgroundColor : "#1e7546";
  const foreground = /^#[\da-f]{6}$/i.test(poster.textColor) ? poster.textColor : "#ffffff";
  context.fillStyle = background;
  context.fillRect(0, 0, 1200, 1500);

  if (poster.template === "modern") {
    context.fillStyle = "rgba(255,255,255,.11)";
    context.beginPath(); context.arc(1090, 105, 300, 0, Math.PI * 2); context.fill();
    context.beginPath(); context.arc(40, 1460, 260, 0, Math.PI * 2); context.fill();
  } else if (poster.template === "product") {
    context.fillStyle = "rgba(255,255,255,.13)";
    context.beginPath(); context.roundRect(100, 470, 1000, 490, 36); context.fill();
  } else if (poster.template === "event") {
    context.strokeStyle = "rgba(255,255,255,.65)"; context.lineWidth = 5;
    context.strokeRect(48, 48, 1104, 1404);
    context.fillStyle = "rgba(255,255,255,.16)";
    context.beginPath(); context.arc(1040, 360, 80, 0, Math.PI * 2); context.fill();
  } else if (poster.template === "minimal") {
    context.strokeStyle = "rgba(255,255,255,.55)"; context.lineWidth = 2;
    context.strokeRect(68, 68, 1064, 1364);
    context.fillStyle = "rgba(255,255,255,.6)"; context.fillRect(470, 160, 260, 4);
  } else {
    context.fillStyle = "rgba(0,0,0,.14)";
    context.beginPath(); context.moveTo(0, 800); context.lineTo(1200, 570); context.lineTo(1200, 950); context.lineTo(0, 1180); context.closePath(); context.fill();
  }

  const imageData = typeof poster.imageData === "string" && /^data:image\/(?:jpeg|png|webp);base64,/i.test(poster.imageData)
    ? poster.imageData
    : "";
  if (imageData) {
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = imageData;
      });
      if (!isCurrent()) return;
      const maxSize = posterValue(poster.imageScale, 15, 75, 44) * 12;
      const ratio = Math.min(maxSize / image.naturalWidth, maxSize / image.naturalHeight);
      const imageWidth = image.naturalWidth * ratio;
      const imageHeight = image.naturalHeight * ratio;
      const centerX = posterValue(poster.imageX, 5, 95, 50) * 12;
      const centerY = posterValue(poster.imageY, 20, 80, 55) * 15;
      context.save();
      if (poster.template === "product") {
        context.fillStyle = "rgba(255,255,255,.9)";
        context.beginPath(); context.roundRect(centerX - imageWidth / 2 - 18, centerY - imageHeight / 2 - 18, imageWidth + 36, imageHeight + 36, 22); context.fill();
      }
      context.drawImage(image, centerX - imageWidth / 2, centerY - imageHeight / 2, imageWidth, imageHeight);
      context.restore();
    } catch {
      // An invalid or stale local image is omitted from the preview/export.
    }
  }

  context.fillStyle = foreground;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = "700 34px Arial, sans-serif";
  context.fillText(String(business.name || "YOUR BUSINESS").slice(0, 80), 600, 105, 1000);
  context.font = "700 22px Arial, sans-serif";
  context.fillText(String(poster.type || "offer").replace(/-/g, " ").toUpperCase(), 600, 170, 900);

  const titleSize = posterValue(poster.titleSize, 30, 92, 76);
  context.font = `800 ${titleSize}px Arial, sans-serif`;
  const titleLines = wrapPosterText(context, poster.title, 1000, 2);
  const titleStart = 230;
  titleLines.forEach((line, index) => context.fillText(line, 600, titleStart + index * titleSize * 1.12, 1000));

  const subtitleY = titleStart + Math.max(1, titleLines.length) * titleSize * 1.12 + 24;
  context.font = `600 ${posterValue(poster.bodySize, 14, 40, 28)}px Arial, sans-serif`;
  wrapPosterText(context, poster.subtitle, 960, 2).forEach((line, index) => {
    context.fillText(line, 600, subtitleY + index * posterValue(poster.bodySize, 14, 40, 28) * 1.3, 960);
  });

  context.font = `400 ${posterValue(poster.bodySize, 14, 40, 28)}px Arial, sans-serif`;
  wrapPosterText(context, poster.description, 940, 2).forEach((line, index) => {
    context.fillText(line, 600, 1060 + index * posterValue(poster.bodySize, 14, 40, 28) * 1.35, 940);
  });

  if (String(poster.price || "").trim()) {
    context.font = `800 ${Math.min(62, titleSize)}px Arial, sans-serif`;
    context.fillText(String(poster.price).slice(0, 36), 600, 1210, 980);
  }

  const cta = String(poster.callToAction || "").trim();
  if (cta) {
    context.font = "700 32px Arial, sans-serif";
    const buttonWidth = Math.min(720, Math.max(260, context.measureText(cta).width + 100));
    context.fillStyle = foreground;
    context.beginPath(); context.roundRect(600 - buttonWidth / 2, 1300 - 34, buttonWidth, 68, 34); context.fill();
    context.fillStyle = background;
    context.fillText(cta.slice(0, 80), 600, 1300, buttonWidth - 40);
  }

  context.fillStyle = foreground;
  context.font = "500 26px Arial, sans-serif";
  context.fillText(String(poster.contact || business.phone || business.email || business.website || "").slice(0, 100), 600, 1430, 1000);
}

export default function App() {
  const [data, setData] = useState(loadData);
  const [active, setActive] = useState("Dashboard");
  const [headline, setHeadline] = useState("Quality products. Trusted service.");
  const [product, setProduct] = useState({ name: "", price: "", description: "", url: "" });
  const [customer, setCustomer] = useState(emptyCustomer);
  const [editingCustomerId, setEditingCustomerId] = useState(null);
  const [customerError, setCustomerError] = useState("");
  const [customerNotice, setCustomerNotice] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerStatusFilter, setCustomerStatusFilter] = useState("All");
  const [customerSort, setCustomerSort] = useState("recent");
  const [qrType, setQrType] = useState("website");
  const [qrProductId, setQrProductId] = useState("");
  const [qrContent, setQrContent] = useState("");
  const [qrTitle, setQrTitle] = useState("Business QR Code");
  const [qrForeground, setQrForeground] = useState("#17211d");
  const [qrBackground, setQrBackground] = useState("#ffffff");
  const qrCanvasRef = useRef(null);
  const [posterImageError, setPosterImageError] = useState("");
  const posterCanvasRef = useRef(null);
  const [chatMessages, setChatMessages] = useState(loadChatHistory);
  const [chatDraft, setChatDraft] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState("");
  const [assistantStatus, setAssistantStatus] = useState({ checking: true, configured: false });
  const [assistantMode, setAssistantMode] = useState("auto");
  const chatEndRef = useRef(null);
  const skipDataPersistenceRef = useRef(false);
  const skipChatPersistenceRef = useRef(false);
  const [backupStatus, setBackupStatus] = useState({ error: "", success: "" });
  const [savedMessage, setSavedMessage] = useState("");
  const [supabaseClient, setSupabaseClient] = useState(null);
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(supabaseConfigured);
  const [authInitAttempt, setAuthInitAttempt] = useState(0);
  const [authMode, setAuthMode] = useState("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [cloudReady, setCloudReady] = useState(false);
  const [cloudChoiceRequired, setCloudChoiceRequired] = useState(false);
  const [cloudHasData, setCloudHasData] = useState(false);
  const [cloudStatus, setCloudStatus] = useState({ state: "idle", message: "" });
  const [localDataPresent] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) !== null || localStorage.getItem(CHAT_STORAGE_KEY) !== null; }
    catch { return false; }
  });
  const [migrationBusy, setMigrationBusy] = useState(false);
  const cloudLoadGeneration = useRef(0);

  const business = data.business;
  const poster = data.poster;
  const assistantProducts = data.products.map((item) => ({
    name: item.name, description: item.description || "", price: item.price || "", currency: business.currency || "",
  }));
  const customerStats = {
    total: data.customers.length,
    active: data.customers.filter((item) => item.status === "Active").length,
    leads: data.customers.filter((item) => item.status === "Lead").length,
    inactive: data.customers.filter((item) => item.status === "Inactive").length,
  };
  const profileChecklist = [
    business.name, business.type, business.country, business.currency, business.language,
    business.phone, business.email, business.website, business.address, business.hours,
    business.description, business.color,
  ];
  const completedProfileFields = profileChecklist.filter((value) => String(value || "").trim()).length;
  const profileCompletion = Math.round((completedProfileFields / profileChecklist.length) * 100);
  const recentCustomers = [...data.customers]
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
    .slice(0, 4);
  const recentProducts = [...data.products].slice(-4).reverse();
  const visibleCustomers = useMemo(() => {
    const query = customerSearch.trim().toLocaleLowerCase();
    const filtered = data.customers.filter((item) => {
      const matchesStatus = customerStatusFilter === "All" || item.status === customerStatusFilter;
      const matchesQuery = !query || [item.name, item.phone, item.email]
        .some((value) => value.toLocaleLowerCase().includes(query));
      return matchesStatus && matchesQuery;
    });
    return filtered.sort((a, b) => customerSort === "name"
      ? a.name.localeCompare(b.name)
      : (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  }, [data.customers, customerSearch, customerStatusFilter, customerSort]);

  useEffect(() => {
    if (!supabaseConfigured) return undefined;
    let alive = true;
    let subscription;
    getSupabaseClient().then(async (client) => {
      if (!alive) return;
      setSupabaseClient(client);
      const { data: sessionData, error } = await withTimeout(
        client.auth.getSession(),
        20_000,
        "Checking your Supabase session timed out. Check your connection and retry.",
      );
      if (error) throw error;
      if (alive) setSession(sessionData.session);
      const result = client.auth.onAuthStateChange((_event, nextSession) => {
        if (alive) {
          setAuthError("");
          setSession(nextSession);
          setCloudReady(false);
          setCloudChoiceRequired(false);
        }
      });
      subscription = result.data.subscription;
    }).catch((error) => {
      if (alive) setAuthError(error instanceof Error ? error.message : "Supabase could not be initialized.");
    }).finally(() => { if (alive) setAuthLoading(false); });
    return () => { alive = false; subscription?.unsubscribe(); };
  }, [authInitAttempt]);

  useEffect(() => {
    if (!supabaseConfigured || !session || !supabaseClient) return undefined;
    const generation = ++cloudLoadGeneration.current;
    readCloudData(supabaseClient, initialData).then(normalizeCloudSnapshot).then((cloud) => {
      if (generation !== cloudLoadGeneration.current) return;
      setData(cloud.data);
      setChatMessages(cloud.chatHistory);
      setCloudHasData(cloud.hasData);
      setCloudChoiceRequired(!cloud.hasData && localDataPresent);
      setCloudReady(!localDataPresent || cloud.hasData);
      setCloudStatus({ state: "ready", message: "Cloud workspace loaded." });
    }).catch((error) => {
      if (generation !== cloudLoadGeneration.current) return;
      setCloudStatus({ state: "error", message: error instanceof Error ? error.message : "Cloud data could not be loaded. Check that the Supabase migration has been applied." });
    });
    return () => { cloudLoadGeneration.current += 1; };
  }, [session, supabaseClient, localDataPresent]);

  useEffect(() => {
    let active = true;
    fetch("/api/status")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Status unavailable")))
      .then((status) => { if (active) setAssistantStatus({ checking: false, configured: status.configured === true }); })
      .catch(() => { if (active) setAssistantStatus({ checking: false, configured: false }); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (supabaseConfigured && session) return;
    if (supabaseConfigured) return;
    if (skipChatPersistenceRef.current) {
      skipChatPersistenceRef.current = false;
      return;
    }
    try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatMessages.slice(-50))); }
    catch { console.warn("BizBuddy could not save assistant chat history."); }
  }, [chatMessages, session]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages, chatLoading]);

  const qrResult = useMemo(() => {
    const input = qrContent.trim();
    if (!input) return { error: "Enter content to generate a QR code." };

    let payload = input;
    if (qrType === "website" || qrType === "product") {
      payload = safeWebsiteURL(input);
      if (!payload) return { error: "Enter a valid website URL, such as https://example.com." };
    } else if (qrType === "whatsapp") {
      const phone = input.replace(/[^\d]/g, "");
      if (phone.length < 8 || phone.length > 15) {
        return { error: "Enter a WhatsApp number with country code (8–15 digits)." };
      }
      payload = `https://wa.me/${phone}`;
    } else if (qrType === "phone") {
      const phone = input.replace(/[^\d+]/g, "");
      if (phone.replace(/\D/g, "").length < 3) return { error: "Enter a valid phone number." };
      payload = `tel:${phone}`;
    } else if (qrType === "email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) {
        return { error: "Enter a valid email address." };
      }
      payload = `mailto:${input}`;
    }

    try {
      const code = qrcode(0, "M");
      code.addData(payload);
      code.make();
      return { code };
    } catch {
      return { error: "This content is too long to fit in a QR code. Shorten it and try again." };
    }
  }, [qrContent, qrType]);

  useEffect(() => {
    const canvas = qrCanvasRef.current;
    if (!canvas || !qrResult.code) return;

    const size = 480;
    const margin = 4;
    const count = qrResult.code.getModuleCount();
    const cellSize = size / (count + margin * 2);
    const context = canvas.getContext("2d");
    canvas.width = size;
    canvas.height = size;
    context.fillStyle = qrBackground;
    context.fillRect(0, 0, size, size);
    context.fillStyle = qrForeground;
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (qrResult.code.isDark(row, column)) {
          const x = Math.round((column + margin) * cellSize);
          const y = Math.round((row + margin) * cellSize);
          const right = Math.round((column + margin + 1) * cellSize);
          const bottom = Math.round((row + margin + 1) * cellSize);
          context.fillRect(x, y, right - x, bottom - y);
        }
      }
    }
  }, [qrResult, qrForeground, qrBackground]);

  useEffect(() => {
    if (supabaseConfigured) return;
    if (skipDataPersistenceRef.current) {
      skipDataPersistenceRef.current = false;
      return;
    }
    if (!saveData(data)) {
      console.warn("BizBuddy could not save data to browser storage.");
    }
  }, [data, session]);

  useEffect(() => {
    if (!supabaseConfigured || !session || !supabaseClient || !cloudReady) return undefined;
    const timer = window.setTimeout(() => {
      setCloudStatus({ state: "saving", message: "Saving changes to your account…" });
      saveCloudData(supabaseClient, data, chatMessages).then(() => {
        setCloudHasData(true);
        setCloudStatus({ state: "ready", message: "All changes saved to your account." });
      }).catch((error) => {
        setCloudStatus({ state: "error", message: error instanceof Error ? error.message : "Cloud save failed. Your current changes remain on screen; retry after checking your connection." });
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [data, chatMessages, session, supabaseClient, cloudReady]);

  const submitAuth = async (event) => {
    event.preventDefault();
    setAuthError("");
    setAuthNotice("");
    if (!supabaseClient) return setAuthError("Supabase is still connecting. Try again in a moment.");
    try {
      const result = authMode === "signup"
        ? await supabaseClient.auth.signUp({ email: authEmail.trim(), password: authPassword })
        : await supabaseClient.auth.signInWithPassword({ email: authEmail.trim(), password: authPassword });
      if (result.error) throw result.error;
      if (authMode === "signup" && !result.data.session) {
        setAuthNotice("Check your email for the confirmation link, then return here to log in.");
      } else if (authMode === "signup") {
        setAuthNotice("Your account is ready. Loading your workspace…");
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Authentication failed. Check your details and try again.");
    }
  };

  const signOut = async () => {
    if (!supabaseClient) return;
    const { error } = await supabaseClient.auth.signOut();
    if (error) setAuthError(error.message);
    else {
      cloudLoadGeneration.current += 1;
      setSession(null);
      setCloudReady(false);
      setCloudChoiceRequired(false);
      setCloudHasData(false);
      setCloudStatus({ state: "idle", message: "" });
      setData({ ...initialData, business: { ...emptyBusiness }, poster: { ...emptyPoster } });
      setChatMessages([]);
      setCustomer(emptyCustomer);
      setProduct({ name: "", price: "", description: "", url: "" });
      setEditingCustomerId(null);
    }
  };

  const reloadCloudWorkspace = async () => {
    if (!supabaseClient) return;
    setCloudStatus({ state: "loading", message: "Loading your secure cloud workspace…" });
    try {
      const cloud = normalizeCloudSnapshot(await readCloudData(supabaseClient, initialData));
      setData(cloud.data);
      setChatMessages(cloud.chatHistory);
      setCloudHasData(cloud.hasData);
      setCloudChoiceRequired(!cloud.hasData && localDataPresent);
      setCloudReady(!localDataPresent || cloud.hasData);
      setCloudStatus({ state: "ready", message: "Cloud workspace loaded." });
    } catch (error) {
      setCloudStatus({ state: "error", message: error instanceof Error ? error.message : "Cloud data could not be loaded." });
    }
  };

  const migrateLocalWorkspace = async () => {
    if (!supabaseClient || !session || migrationBusy || cloudHasData) return;
    setMigrationBusy(true);
    setCloudStatus({ state: "loading", message: "Copying your browser data into your account…" });
    try {
      let localData;
      let localChat;
      try {
        if (localStorage.getItem(STORAGE_KEY) !== null) JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (localStorage.getItem(CHAT_STORAGE_KEY) !== null) JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY));
        localData = loadData();
        localChat = loadChatHistory();
      } catch {
        throw new Error("The saved browser data is malformed and was not copied. Export or repair it in Local demo mode before trying again.");
      }
      const checked = validateAndNormalizeBackup({
        format: "bizbuddy-ai-backup", version: 1, business: localData.business,
        products: localData.products, customers: localData.customers,
        settings: { poster: localData.poster, assistantInstructions: localData.assistantInstructions },
        chatHistory: localChat,
      });
      localData = checked.data;
      localChat = checked.chatHistory;
      await migrateLocalData(supabaseClient, localData, localChat);
      const cloud = normalizeCloudSnapshot(await readCloudData(supabaseClient, initialData));
      setData(cloud.data);
      setChatMessages(cloud.chatHistory);
      setCloudHasData(true);
      setCloudChoiceRequired(false);
      setCloudReady(true);
      setCloudStatus({ state: "ready", message: "Local data copied to your cloud account. Your original browser copy is still available." });
    } catch (error) {
      setCloudStatus({ state: "error", message: error instanceof Error ? error.message : "Migration failed. Your local data has not been removed." });
    } finally {
      setMigrationBusy(false);
    }
  };

  useEffect(() => {
    const canvas = posterCanvasRef.current;
    let current = true;
    if (canvas) drawPosterCanvas(canvas, poster, business, 600, 750, () => current).catch(() => {});
    return () => { current = false; };
  }, [poster, business]);

  const updatePoster = (event) => {
    const { name, value } = event.target;
    setData((previous) => ({
      ...previous,
      poster: { ...previous.poster, [name]: value },
    }));
  };

  const uploadPosterImage = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    setPosterImageError("");
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setPosterImageError("Choose a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setPosterImageError("Choose an image smaller than 5 MB.");
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      if (image.naturalWidth * image.naturalHeight > 40_000_000) {
        setPosterImageError("This image has too many pixels. Choose a smaller image.");
        return;
      }
      try {
        const maxDimension = 1400;
        const ratio = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Image processing is unavailable");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const imageData = canvas.toDataURL("image/jpeg", 0.84);
        if (imageData.length > 1_800_000) {
          setPosterImageError("This image is still too large after processing. Try a smaller image.");
          return;
        }
        setData((previous) => ({
          ...previous,
          poster: { ...previous.poster, imageData },
        }));
      } catch {
        setPosterImageError("This image could not be processed. Try another file.");
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setPosterImageError("This image could not be opened. Try another file.");
    };
    image.src = objectUrl;
  };

  const updateBusiness = (event) => {
    const { name, value } = event.target;

    setData((prev) => ({
      ...prev,
      business: {
        ...prev.business,
        [name]: value,
        ...(name === "country" && currencies[value]
          ? { currency: currencies[value] }
          : {}),
      },
    }));

    setSavedMessage("");
  };

  const updateProduct = (event) => {
    setProduct((prev) => ({
      ...prev,
      [event.target.name]: event.target.value,
    }));
  };

  const updateCustomer = (event) => {
    setCustomer((prev) => ({
      ...prev,
      [event.target.name]: event.target.value,
    }));
    setCustomerError("");
    setCustomerNotice("");
  };

  const saveProfile = (event) => {
    event.preventDefault();
    setSavedMessage("Business profile saved!");
  };

  const addProduct = (event) => {
    event.preventDefault();

    if (!product.name.trim()) return;

    setData((prev) => ({
      ...prev,
      products: [
        ...prev.products,
        { ...product, id: crypto.randomUUID() },
      ],
    }));

    setProduct({ name: "", price: "", description: "", url: "" });
  };

  const deleteProduct = (id) => {
    setData((prev) => ({
      ...prev,
      products: prev.products.filter((item) => item.id !== id),
    }));
  };

  const downloadQr = () => {
    const canvas = qrCanvasRef.current;
    if (!canvas || !qrResult.code) return;
    const link = document.createElement("a");
    const filename = (qrTitle.trim() || "bizbuddy-qr-code")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bizbuddy-qr-code";
    link.download = `${filename}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  const saveCustomer = (event) => {
    event.preventDefault();
    const name = customer.name.trim();
    const email = customer.email.trim();
    const phone = customer.phone.trim();
    if (!name) return setCustomerError("Enter a customer name.");
    if (name.length > 120) return setCustomerError("Customer names must be 120 characters or fewer.");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setCustomerError("Enter a valid email address, or leave the field blank.");
    if (phone) {
      const digits = phone.replace(/\D/g, "");
      if (!/^[+\d][\d\s().-]*$/.test(phone) || digits.length < 7 || digits.length > 15) {
        return setCustomerError("Enter a phone number with 7–15 digits, or leave the field blank.");
      }
    }
    if (!customerStatuses.includes(customer.status)) return setCustomerError("Choose Lead, Active, or Inactive.");

    if (editingCustomerId) {
      setData((prev) => ({
        ...prev,
        customers: prev.customers.map((item) => item.id === editingCustomerId
          ? { ...item, ...customer, name, email, phone }
          : item),
      }));
      setCustomerNotice("Customer details updated.");
    } else {
      setData((prev) => ({
        ...prev,
        customers: [...prev.customers, {
          ...customer,
          name,
          email,
          phone,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        }],
      }));
      setCustomerNotice("Customer added.");
    }
    setCustomer(emptyCustomer);
    setEditingCustomerId(null);
    setCustomerError("");
  };

  const editCustomer = (item) => {
    setCustomer({ ...emptyCustomer, ...item });
    setEditingCustomerId(item.id);
    setCustomerError("");
    setCustomerNotice("");
  };

  const cancelCustomerEdit = () => {
    setCustomer(emptyCustomer);
    setEditingCustomerId(null);
    setCustomerError("");
    setCustomerNotice("");
  };

  const deleteCustomer = (id) => {
    setData((prev) => ({
      ...prev,
      customers: prev.customers.filter((item) => item.id !== id),
    }));
    if (editingCustomerId === id) cancelCustomerEdit();
    setCustomerNotice("Customer deleted.");
  };

  const exportCustomers = () => {
    const csvCell = (value) => {
      const text = String(value ?? "");
      const safeText = /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${safeText.replace(/"/g, '""')}"`;
    };
    const headers = ["Name", "Phone", "Email", "Business / Company", "Notes", "Status", "Added"];
    const rows = data.customers.map((item) => [
      item.name, item.phone, item.email, item.company, item.notes, item.status, item.createdAt,
    ]);
    const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    downloadFile(csv, "bizbuddy-customers.csv", "text/csv;charset=utf-8");
  };

  const exportBackup = () => {
    const backup = {
      format: "bizbuddy-ai-backup",
      version: 1,
      business: data.business,
      products: data.products,
      customers: data.customers,
      settings: {
        poster: data.poster,
        assistantInstructions: data.assistantInstructions || "",
      },
      chatHistory: chatMessages.slice(-50),
    };
    downloadFile(JSON.stringify(backup, null, 2), "bizbuddy-backup.json", "application/json;charset=utf-8");
  };

  const importBackup = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    setBackupStatus({ error: "", success: "" });
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json") || file.size > 20 * 1024 * 1024) {
      setBackupStatus({ error: "Choose a JSON backup file smaller than 20 MB.", success: "" });
      return;
    }

    try {
      const content = await file.text();
      let parsed;
      try { parsed = JSON.parse(content); }
      catch { throw new Error("This file is not valid JSON."); }
      const restored = validateAndNormalizeBackup(parsed);
      const nextData = restored.data;
      const nextChat = restored.chatHistory;
      const nextDataText = JSON.stringify(nextData);
      const nextChatText = JSON.stringify(nextChat);
      const previousDataText = localStorage.getItem(STORAGE_KEY);
      const previousChatText = localStorage.getItem(CHAT_STORAGE_KEY);

      try {
        localStorage.setItem(STORAGE_KEY, nextDataText);
        localStorage.setItem(CHAT_STORAGE_KEY, nextChatText);
      } catch {
        try {
          if (previousDataText === null) localStorage.removeItem(STORAGE_KEY);
          else localStorage.setItem(STORAGE_KEY, previousDataText);
          if (previousChatText === null) localStorage.removeItem(CHAT_STORAGE_KEY);
          else localStorage.setItem(CHAT_STORAGE_KEY, previousChatText);
        } catch {
          // Report the failed restore; never replace app state with an unpersisted backup.
        }
        throw new Error("Browser storage could not save this backup. Free up local storage space and try again.");
      }

      setData(nextData);
      setChatMessages(nextChat);
      setCustomer(emptyCustomer);
      setEditingCustomerId(null);
      setBackupStatus({ error: "", success: "Backup restored successfully." });
    } catch (error) {
      setBackupStatus({ error: error instanceof Error ? error.message : "This backup could not be restored.", success: "" });
    }
  };

  const clearAllLocalData = () => {
    if (!window.confirm("Clear all BizBuddy business data, customers, products, poster settings, chatbot instructions, and chat history from this browser? This cannot be undone.")) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(CHAT_STORAGE_KEY);
    } catch {
      setBackupStatus({ error: "Browser storage could not be cleared. Please check the browser's storage permissions and try again.", success: "" });
      return;
    }

    if (supabaseConfigured && session) {
      setBackupStatus({ error: "", success: "The browser copy was cleared. Your signed-in cloud workspace was left unchanged." });
      return;
    }

    skipDataPersistenceRef.current = true;
    skipChatPersistenceRef.current = true;
    setData({ ...initialData, business: { ...emptyBusiness }, poster: { ...emptyPoster } });
    setChatMessages([]);
    setProduct({ name: "", price: "", description: "", url: "" });
    setCustomer(emptyCustomer);
    setEditingCustomerId(null);
    setCustomerSearch("");
    setCustomerStatusFilter("All");
    setCustomerSort("recent");
    setHeadline("Quality products. Trusted service.");
    setQrType("website");
    setQrProductId("");
    setQrContent("");
    setQrTitle("Business QR Code");
    setQrForeground("#17211d");
    setQrBackground("#ffffff");
    setChatDraft("");
    setChatError("");
    setAssistantMode("auto");
    setPosterImageError("");
    setCustomerError("");
    setCustomerNotice("");
    setSavedMessage("");
    setBackupStatus({ error: "", success: "BizBuddy data was cleared from this browser." });
  };

  const downloadFile = (content, filename, type) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportWebsite = () => {
    const name = escapeHTML(business.name || "Your Business");
    const type = escapeHTML(business.type || "Professional Services");
    const description = escapeHTML(
      business.description || "We deliver quality products and trusted service."
    );
    const title = escapeHTML(headline);
    const language = languageTags[business.language] || "en";
    const color = /^#[0-9a-f]{6}$/i.test(business.color)
      ? business.color
      : "#1e7546";

    const phone = String(business.phone || "").replace(/[^\d+]/g, "");
    const whatsapp = phone.replace(/\D/g, "");
    const websiteURL = safeWebsiteURL(business.website);

    const services = data.products.length
      ? data.products.map((item) => `
          <article class="card">
            <h3>${escapeHTML(item.name)}</h3>
            <p>${escapeHTML(item.description || "Contact us to learn more.")}</p>
            <strong>${escapeHTML(item.price || "")}</strong>
          </article>
        `).join("")
      : `
          <article class="card"><h3>${type}</h3><p>${description}</p></article>
          <article class="card"><h3>Quality & Reliability</h3><p>Dependable service and customer satisfaction.</p></article>
          <article class="card"><h3>Customer Support</h3><p>Our team is ready to help with your requirements.</p></article>
        `;

    const html = `<!DOCTYPE html>
<html lang="${language}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${description}">
<meta name="theme-color" content="${color}">
<title>${name} | ${type}</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#17211d;line-height:1.7}
.container{width:min(1100px,90%);margin:auto}
nav{padding:20px 0;border-bottom:1px solid #eee}
nav .container{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}
.logo{font-weight:800;color:${color};font-size:22px}
nav a{margin-left:18px;color:#17211d;text-decoration:none}
.hero{background:${color};color:white;padding:100px 0}
.hero h1{font-size:clamp(36px,7vw,72px);line-height:1.1;margin:15px 0}
.hero p{max-width:650px}
.button{display:inline-block;padding:12px 22px;border-radius:8px;background:white;color:${color};text-decoration:none;font-weight:bold;margin:8px 8px 0 0}
section{padding:75px 0}
.about{background:#f5f8f5}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}
.card{border:1px solid #e5ebe5;border-radius:14px;padding:25px}
.card h3{color:${color}}
.contact{background:#f5f8f5}
footer{background:#17211d;color:white;padding:30px 0}
@media(max-width:700px){.grid{grid-template-columns:1fr}.hero{padding:65px 0}}
</style>
</head>
<body>
<nav><div class="container"><div class="logo">${name}</div><div><a href="#about">About</a><a href="#services">Services</a><a href="#contact">Contact</a></div></div></nav>
<header class="hero"><div class="container">
<p>${type}</p><h1>${title}</h1><p>${description}</p>
${phone ? `<a class="button" href="tel:${escapeHTML(phone)}">Call us</a>` : ""}
<a class="button" href="#services">Explore services</a>
</div></header>
<section id="about" class="about"><div class="container"><h2>About us</h2><p>${description}</p></div></section>
<section id="services"><div class="container"><h2>Our products & services</h2><div class="grid">${services}</div></div></section>
<section id="contact" class="contact"><div class="container"><h2>Let's work together.</h2><p>${escapeHTML(business.address)}</p>
${phone ? `<a class="button" href="tel:${escapeHTML(phone)}">${escapeHTML(phone)}</a>` : ""}
${whatsapp ? `<a class="button" href="https://wa.me/${escapeHTML(whatsapp)}">WhatsApp</a>` : ""}
${business.email ? `<p>Email: ${escapeHTML(business.email)}</p>` : ""}
${websiteURL ? `<p><a href="${escapeHTML(websiteURL)}" rel="noopener noreferrer">Visit our website</a></p>` : ""}
</div></section>
<footer><div class="container">© ${new Date().getFullYear()} ${name}. All rights reserved.</div></footer>
</body></html>`;

    downloadFile(html, "bizbuddy-website.html", "text/html;charset=utf-8");
  };

  const downloadPoster = async () => {
    const canvas = document.createElement("canvas");
    await drawPosterCanvas(canvas, poster, business, 2400, 3000);
    const filename = String(poster.title || "bizbuddy-poster")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bizbuddy-poster";
    const link = document.createElement("a");
    link.download = `${filename}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  const sendAssistantMessage = async (event) => {
    event.preventDefault();
    const content = chatDraft.trim();
    if (!content || chatLoading) return;

    const userMessage = { id: `${Date.now()}-${Math.random()}`, role: "user", content, createdAt: new Date().toISOString() };
    const history = [...chatMessages, userMessage].slice(-50);
    setChatMessages(history);
    setChatDraft("");
    setChatError("");
    setChatLoading(true);

    try {
      let reply;
      const aiMode = assistantStatus.configured && assistantMode !== "demo";
      if (aiMode) {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
          },
          body: JSON.stringify({
            business: { ...business, products: assistantProducts },
            instructions: data.assistantInstructions || "",
            messages: history.slice(-16).map(({ role, content: messageContent }) => ({ role, content: messageContent })),
          }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "The AI assistant could not reply.");
        if (typeof result.reply !== "string" || !result.reply.trim()) throw new Error("The AI assistant returned an empty reply.");
        reply = result.reply.trim();
      } else {
        reply = localAssistantReply(content, business, assistantProducts);
      }
      setChatMessages((current) => [...current, {
        id: `${Date.now()}-${Math.random()}`, role: "assistant", content: reply, createdAt: new Date().toISOString(),
      }].slice(-50));
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "The assistant is temporarily unavailable. Try local demo mode.");
    } finally {
      setChatLoading(false);
    }
  };

  const clearAssistantChat = () => {
    if (chatLoading) return;
    if (window.confirm("Clear the saved customer assistant chat history?")) {
      setChatMessages([]);
      setChatError("");
    }
  };

  const updateAssistantInstructions = (event) => {
    const value = event.target.value.slice(0, 2000);
    setData((previous) => ({ ...previous, assistantInstructions: value }));
  };

  const input = (label, name, placeholder, type = "text") => (
    <label className="bb-field" key={name}>
      {label}
      <input
        type={type}
        name={name}
        value={business[name] || ""}
        onChange={updateBusiness}
        placeholder={placeholder}
      />
    </label>
  );

  const field = (label, name, value, onChange, placeholder = "", type = "text", maxLength) => (
    <label className="bb-field" key={name}>
      {label}
      <input
        type={type}
        name={name}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        maxLength={maxLength}
      />
    </label>
  );

  const renderDashboard = () => (
    <section className="dashboard-page">
      <section className="dashboard-hero">
        <div>
          <p className="eyebrow">BUSINESS OVERVIEW</p>
          <h1>{business.name ? "Welcome back, " + business.name + "." : "Your business, at a glance."}</h1>
          <p className="subtext">A clear view of your customers, products, and next steps.</p>
        </div>
        <div className="dashboard-name-entry">
          <label htmlFor="dashboard-business-name">Business name</label>
          <div className="business-input">
            <input
              id="dashboard-business-name"
              value={business.name}
              onChange={(event) => setData((prev) => ({
                ...prev,
                business: { ...prev.business, name: event.target.value },
              }))}
              placeholder="Enter your business name"
            />
            <button type="button" onClick={() => setActive("My Business")}>Profile →</button>
          </div>
        </div>
      </section>

      <section className="dashboard-stats" aria-label="Business statistics">
        <article className="dashboard-stat-card"><span className="dashboard-stat-icon customers">♙</span><div><strong>{customerStats.total}</strong><span>Total customers</span></div><button type="button" aria-label="View customers" onClick={() => { setCustomerStatusFilter("All"); setActive("Customers"); }}>→</button></article>
        <article className="dashboard-stat-card"><span className="dashboard-stat-icon active">✓</span><div><strong>{customerStats.active}</strong><span>Active customers</span></div><button type="button" aria-label="View active customers" onClick={() => { setCustomerStatusFilter("Active"); setActive("Customers"); }}>→</button></article>
        <article className="dashboard-stat-card"><span className="dashboard-stat-icon leads">✳</span><div><strong>{customerStats.leads}</strong><span>Leads</span></div><button type="button" aria-label="View leads" onClick={() => { setCustomerStatusFilter("Lead"); setActive("Customers"); }}>→</button></article>
        <article className="dashboard-stat-card"><span className="dashboard-stat-icon products">▦</span><div><strong>{data.products.length}</strong><span>Products</span></div><button type="button" aria-label="View products" onClick={() => setActive("QR Catalog")}>→</button></article>
      </section>

      <section className="dashboard-section">
        <div className="dashboard-section-heading"><div><p className="eyebrow">QUICK ACTIONS</p><h2>Pick up where you left off</h2></div></div>
        <div className="dashboard-actions-grid">
          {dashboardActions.map((action) => (
            <button className="dashboard-action-card" type="button" key={action.page} onClick={() => setActive(action.page)}>
              <span className={"dashboard-action-icon action-" + action.page.toLowerCase().replaceAll(" ", "-")}>{action.icon}</span>
              <span className="dashboard-action-copy"><strong>{action.title}</strong><small>{action.description}</small></span>
              <span className="dashboard-action-arrow" aria-hidden="true">→</span>
            </button>
          ))}
        </div>
      </section>

      <section className="dashboard-lower-grid">
        <article className="dashboard-panel profile-progress-panel">
          <div className="dashboard-panel-heading"><div><p className="eyebrow">BUSINESS PROFILE</p><h2>Complete your profile</h2></div><strong>{profileCompletion}%</strong></div>
          <div className="profile-progress-track" role="progressbar" aria-label="Business profile completion" aria-valuemin="0" aria-valuemax="100" aria-valuenow={profileCompletion}><span style={{ width: profileCompletion + "%" }} /></div>
          <p className="profile-progress-caption">{completedProfileFields} of {profileChecklist.length} profile details added.</p>
          {profileCompletion < 100 ? (
            <div className="profile-progress-empty"><p>Add your business details so your website, poster, and customer assistant can use accurate information.</p><button type="button" onClick={() => setActive("My Business")}>Finish your profile →</button></div>
          ) : (
            <div className="profile-complete-note"><span>✓</span><p>Your business profile is complete and ready to power your tools.</p></div>
          )}
        </article>

        <article className="dashboard-panel recent-panel">
          <div className="dashboard-panel-heading"><div><p className="eyebrow">CUSTOMER ACTIVITY</p><h2>Recent customers</h2></div><button type="button" className="dashboard-text-link" onClick={() => setActive("Customers")}>View all →</button></div>
          {recentCustomers.length ? (
            <ul className="dashboard-recent-list">{recentCustomers.map((item) => (
              <li key={item.id}><span className="recent-avatar">{item.name.trim().charAt(0).toUpperCase() || "?"}</span><span className="recent-item-copy"><strong>{item.name}</strong><small>{item.company || item.email || item.phone || "Customer record"}</small></span><span className={"customer-status status-" + item.status.toLowerCase()}>{item.status}</span></li>
            ))}</ul>
          ) : (
            <div className="dashboard-empty-state"><span>♙</span><p>No customers yet. Add your first customer to start building relationships.</p><button type="button" onClick={() => setActive("Customers")}>Add a customer →</button></div>
          )}
        </article>

        <article className="dashboard-panel recent-panel recent-products-panel">
          <div className="dashboard-panel-heading"><div><p className="eyebrow">YOUR CATALOG</p><h2>Recently added products</h2></div><button type="button" className="dashboard-text-link" onClick={() => setActive("QR Catalog")}>View catalog →</button></div>
          {recentProducts.length ? (
            <ul className="dashboard-recent-list">{recentProducts.map((item) => (
              <li key={item.id}><span className="recent-product-icon">▦</span><span className="recent-item-copy"><strong>{item.name}</strong><small>{item.description || "Product or service"}</small></span><span className="recent-product-price">{item.price ? item.price + " " + business.currency : ""}</span></li>
            ))}</ul>
          ) : (
            <div className="dashboard-empty-state"><span>▦</span><p>Your catalog is empty. Add products or services to start sharing them.</p><button type="button" onClick={() => setActive("QR Catalog")}>Add a product →</button></div>
          )}
        </article>
      </section>
    </section>
  );

  const renderBusiness = () => (
    <section className="profile-page">
      <p className="eyebrow">BUSINESS SETTINGS</p>
      <h1>Tell us about your business.</h1>
      <p className="subtext">These details power your BizBuddy AI tools.</p>

      <form className="profile-form" onSubmit={saveProfile}>
        {input("Business name", "name", "e.g. Acme Studio")}
        {input("Business type", "type", "Retail, restaurant, services")}

        <label className="bb-field">
          Country
          <select name="country" value={business.country} onChange={updateBusiness}>
            <option value="">Select your country</option>
            {countries.map(({ region, name }) => (
              <option key={region} value={name}>{name}</option>
            ))}
          </select>
        </label>

        {input("Currency", "currency", "e.g. USD")}
        {input("Website language", "language", "e.g. English")}
        {input("Phone number", "phone", "+1 555 123 4567", "tel")}
        {input("Email", "email", "hello@example.com", "email")}
        {input("Website", "website", "https://example.com")}
        {input("Business address", "address", "Business location")}
        {input("Business hours", "hours", "e.g. Mon–Fri, 9:00 AM–5:00 PM")}

        <label className="bb-field">
          About your business
          <textarea
            name="description"
            value={business.description}
            onChange={updateBusiness}
            rows="4"
            placeholder="What do you offer?"
          />
        </label>

        <label className="bb-field">
          Brand colour
          <input
            type="color"
            name="color"
            value={business.color}
            onChange={updateBusiness}
          />
        </label>

        <button type="submit">Save business profile →</button>
        {savedMessage && <p className="saved-message">✓ {savedMessage}</p>}
      </form>
    </section>
  );

  const renderWebsiteBuilder = () => (
    <section className="builder-page">
      <p className="eyebrow">FREE WEBSITE BUILDER</p>
      <h1>Build your business website.</h1>
      <p className="subtext">Edit your details and preview your website instantly.</p>

      <div className="builder-layout">
        <form className="profile-form" onSubmit={(event) => event.preventDefault()}>
          {input("Business name", "name", "Your business name")}
          {input("Business type", "type", "What industry are you in?")}
          {input("Phone number", "phone", "+1 555 123 4567", "tel")}
          {input("Business address", "address", "Business address")}

          <label className="bb-field">
            Headline
            <input value={headline} onChange={(event) => setHeadline(event.target.value)} />
          </label>

          <label className="bb-field">
            About your business
            <textarea
              name="description"
              value={business.description}
              onChange={updateBusiness}
              rows="4"
              placeholder="Describe your products or services"
            />
          </label>

          <label className="bb-field">
            Brand colour
            <input
              type="color"
              name="color"
              value={business.color}
              onChange={updateBusiness}
            />
          </label>

          <button type="button" onClick={exportWebsite}>
            Download website HTML ↓
          </button>
        </form>

        <div className="website-preview">
          <div style={{
            background: business.color,
            color: "white",
            padding: "32px 24px",
            borderRadius: "10px 10px 0 0",
          }}>
            <p>✦ {business.name || "Your Business"}</p>
            <h2>{headline}</h2>
            <p>{business.description || "Welcome. Discover what makes our business special."}</p>
            {business.phone && <strong>☎ {business.phone}</strong>}
          </div>

          <div style={{ padding: 24 }}>
            <h2>About us</h2>
            <p>{business.description || "Your business description will appear here."}</p>
            <p>{business.type}</p>
            <p>{business.address}</p>
            <button
              type="button"
              onClick={() => {
                if (business.phone) {
                  window.location.href = `tel:${business.phone}`;
                }
              }}
            >
              Contact us
            </button>
          </div>

          <p style={{ padding: 16, background: "#f1f5f1", margin: 0 }}>
            Made with BizBuddy AI
          </p>
        </div>
      </div>
    </section>
  );

  const renderCatalog = () => (
    <section className="profile-page">
      <p className="eyebrow">QR CATALOG</p>
      <h1>Your products and QR codes.</h1>
      <p className="subtext">Create downloadable QR codes and manage your product catalog.</p>

      <section className="qr-generator" aria-labelledby="qr-generator-title">
        <div>
          <p className="eyebrow">QR CODE GENERATOR</p>
          <h2 id="qr-generator-title">Create a QR code</h2>
          <form className="profile-form qr-form" onSubmit={(event) => event.preventDefault()}>
            <label className="bb-field">
              Content type
              <select
                value={qrType}
                onChange={(event) => {
                  const type = event.target.value;
                  setQrType(type);
                  if (type === "website") setQrContent(business.website);
                  else if (type === "product") setQrContent(data.products.find((item) => item.id === qrProductId)?.url || "");
                  else if (type === "whatsapp" || type === "phone") setQrContent(business.phone);
                  else if (type === "email") setQrContent(business.email);
                  else setQrContent("");
                }}
              >
                <option value="website">Business website URL</option>
                <option value="product">Product URL</option>
                <option value="whatsapp">WhatsApp contact</option>
                <option value="phone">Phone number</option>
                <option value="email">Email address</option>
                <option value="text">Plain text</option>
              </select>
            </label>

            {qrType === "product" && (
              <label className="bb-field">
                Select a product (optional)
                <select
                  value={qrProductId}
                  onChange={(event) => {
                    const id = event.target.value;
                    setQrProductId(id);
                    setQrContent(data.products.find((item) => item.id === id)?.url || "");
                  }}
                >
                  <option value="">Enter a product URL below</option>
                  {data.products.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
            )}

            <label className="bb-field">
              {qrType === "website" || qrType === "product" ? "URL" : qrType === "whatsapp" || qrType === "phone" ? "Phone number" : qrType === "email" ? "Email address" : "Text to encode"}
              <input
                value={qrContent}
                onChange={(event) => setQrContent(event.target.value)}
                placeholder={qrType === "website" || qrType === "product" ? "https://example.com" : qrType === "whatsapp" ? "+1 555 123 4567 (include country code)" : qrType === "phone" ? "+1 555 123 4567" : qrType === "email" ? "hello@example.com" : "Enter any text"}
                type={qrType === "email" ? "email" : "text"}
                aria-invalid={Boolean(qrResult.error && qrContent.trim())}
              />
            </label>

            <label className="bb-field">
              QR code title
              <input value={qrTitle} onChange={(event) => setQrTitle(event.target.value)} placeholder="Give this QR code a title" />
            </label>

            <div className="qr-colors">
              <label className="bb-field">
                Foreground
                <input type="color" value={qrForeground} onChange={(event) => setQrForeground(event.target.value)} />
              </label>
              <label className="bb-field">
                Background
                <input type="color" value={qrBackground} onChange={(event) => setQrBackground(event.target.value)} />
              </label>
            </div>
          </form>
        </div>

        <div className="qr-preview" aria-live="polite">
          <h3>{qrTitle.trim() || "Untitled QR code"}</h3>
          {qrResult.code ? (
            <canvas ref={qrCanvasRef} className="qr-canvas" aria-label={`${qrTitle || "QR code"} preview`} />
          ) : (
            <div className="qr-empty">Enter valid content to preview your QR code.</div>
          )}
          {qrResult.error && <p className="qr-error" role="status">{qrResult.error}</p>}
          <button type="button" onClick={downloadQr} disabled={!qrResult.code}>
            Download PNG ↓
          </button>
        </div>
      </section>

      <h2 className="catalog-heading">Product catalog</h2>
      <p className="subtext">Add products and their public URLs so you can quickly create product QR codes.</p>

      <form className="profile-form" onSubmit={addProduct}>
        {field("Product name", "name", product.name, updateProduct, "Product name")}
        {field("Price", "price", product.price, updateProduct, "e.g. 25.00", "number")}
        {field("Description", "description", product.description, updateProduct, "Product details")}
        {field("Product URL (optional)", "url", product.url, updateProduct, "https://example.com/product", "url")}
        <button type="submit">Add product →</button>
      </form>

      <div className="tools-grid">
        {data.products.map((item) => (
          <article className="tool-card" key={item.id}>
            <h3>{item.name}</h3>
            <p>{item.description}</p>
            <strong>{item.price} {business.currency}</strong>
            {item.url && <p className="product-url">{item.url}</p>}
            <button onClick={() => deleteProduct(item.id)}>Delete</button>
          </article>
        ))}
      </div>

      <p className="subtext">
        Product QR codes use the public URL you provide. A hosted, shareable catalog page is not included yet.
      </p>
    </section>
  );

  const renderPosterMaker = () => (
    <section className="profile-page">
      <p className="eyebrow">POSTER MAKER</p>
      <h1>Design a poster for your business.</h1>
      <p className="subtext">Build a polished offer, product, service, event, or announcement poster. Your design saves {supabaseConfigured && session ? "to your cloud account" : "in this browser"} as you edit.</p>

      <div className="poster-editor">
        <form className="profile-form poster-controls" onSubmit={(event) => event.preventDefault()}>
          <label className="bb-field">
            Poster type
            <select name="type" value={poster.type} onChange={updatePoster}>
              <option value="offer">Special offer</option><option value="product">Product</option>
              <option value="service">Service</option><option value="event">Event</option>
              <option value="announcement">Announcement</option>
            </select>
          </label>

          <fieldset className="poster-templates">
            <legend>Choose a template</legend>
            <div className="poster-template-grid">
              {[["modern", "Modern"], ["product", "Product focus"], ["event", "Event"], ["minimal", "Minimal"], ["bold", "Bold"]].map(([value, label]) => (
                <button
                  className={poster.template === value ? "poster-template-option selected" : "poster-template-option"}
                  type="button" key={value} aria-pressed={poster.template === value}
                  onClick={() => setData((previous) => ({ ...previous, poster: { ...previous.poster, template: value } }))}
                >
                  <span className={`template-swatch template-${value}`} aria-hidden="true" />{label}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="bb-field">Title<input name="title" value={poster.title} onChange={updatePoster} maxLength="100" placeholder="Your main headline" /></label>
          <label className="bb-field">Subtitle<input name="subtitle" value={poster.subtitle} onChange={updatePoster} maxLength="140" placeholder="A short supporting line" /></label>
          <label className="bb-field">Description<textarea name="description" value={poster.description} onChange={updatePoster} maxLength="240" rows="3" placeholder="Add a few details" /></label>
          <label className="bb-field">Price or offer<input name="price" value={poster.price} onChange={updatePoster} maxLength="36" placeholder="e.g. 20% off or $29" /></label>
          <label className="bb-field">Contact details<input name="contact" value={poster.contact} onChange={updatePoster} maxLength="100" placeholder={business.phone || business.email || "Phone, email, or website"} /></label>
          <label className="bb-field">Call to action<input name="callToAction" value={poster.callToAction} onChange={updatePoster} maxLength="80" placeholder="e.g. Shop now" /></label>

          <div className="poster-style-fields">
            <label className="bb-field">Background color<input type="color" name="backgroundColor" value={poster.backgroundColor} onChange={updatePoster} /></label>
            <label className="bb-field">Text color<input type="color" name="textColor" value={poster.textColor} onChange={updatePoster} /></label>
          </div>
          <label className="bb-field poster-range-field">Title size <output>{poster.titleSize}px</output><input type="range" name="titleSize" min="30" max="92" value={poster.titleSize} onChange={updatePoster} /></label>
          <label className="bb-field poster-range-field">Description size <output>{poster.bodySize}px</output><input type="range" name="bodySize" min="14" max="40" value={poster.bodySize} onChange={updatePoster} /></label>

          <fieldset className="poster-image-controls">
            <legend>Product image</legend>
            <label className="bb-field">Upload PNG, JPEG, or WebP (up to 5 MB)<input type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadPosterImage} /></label>
            {poster.imageData && <button className="poster-secondary-button" type="button" onClick={() => setData((previous) => ({ ...previous, poster: { ...previous.poster, imageData: "" } }))}>Remove image</button>}
            {posterImageError && <p className="poster-error" role="alert">{posterImageError}</p>}
            {poster.imageData && <>
              <label className="bb-field poster-range-field">Image horizontal position <output>{poster.imageX}%</output><input type="range" name="imageX" min="5" max="95" value={poster.imageX} onChange={updatePoster} /></label>
              <label className="bb-field poster-range-field">Image vertical position <output>{poster.imageY}%</output><input type="range" name="imageY" min="20" max="80" value={poster.imageY} onChange={updatePoster} /></label>
              <label className="bb-field poster-range-field">Image size <output>{poster.imageScale}%</output><input type="range" name="imageScale" min="15" max="75" value={poster.imageScale} onChange={updatePoster} /></label>
            </>}
          </fieldset>
          <button type="button" onClick={downloadPoster}>Download high-quality PNG ↓</button>
          <p className="poster-export-note">PNG export · 2400 × 3000 pixels</p>
        </form>

        <div className="poster-preview-panel">
          <div className="poster-preview-heading">
            <div><p className="eyebrow">LIVE PREVIEW</p><h2>{poster.title || "Untitled poster"}</h2></div>
            <span>4:5</span>
          </div>
          <canvas ref={posterCanvasRef} className="poster-canvas" aria-label={`Live poster preview: ${poster.title || "Untitled poster"}`} />
          <p className="poster-preview-tip">Your saved design stays {supabaseConfigured && session ? "in your account" : "on this device"}.</p>
        </div>
      </div>
    </section>
  );

  const renderAssistant = () => {
    const aiMode = assistantStatus.configured && assistantMode !== "demo";
    return (
      <section className="profile-page assistant-page">
        <p className="eyebrow">CUSTOMER ASSISTANT</p>
        <h1>Help your customers get answers.</h1>
        <p className="subtext">Answers use the details in your Business Profile and product catalog. Missing information is called out instead of guessed.</p>

        <section className="assistant-settings" aria-label="Chatbot setup">
          <div className="assistant-mode-header">
            <div>
              <p className="eyebrow">ASSISTANT MODE</p>
              <h2>{assistantStatus.checking ? "Checking AI setup…" : aiMode ? "AI assistant connected" : "Local demo mode"}</h2>
            </div>
            <span className={aiMode ? "assistant-mode-badge ai" : "assistant-mode-badge demo"}>
              {assistantStatus.checking ? "CHECKING" : aiMode ? "AI MODE" : "LOCAL DEMO"}
            </span>
          </div>
          <div className="assistant-mode-actions">
            <button className={!aiMode ? "mode-choice active" : "mode-choice"} type="button" aria-pressed={!aiMode} onClick={() => setAssistantMode("demo")}>Local demo</button>
            {assistantStatus.configured && <button className={aiMode ? "mode-choice active" : "mode-choice"} type="button" aria-pressed={aiMode} onClick={() => setAssistantMode("ai")}>AI assistant</button>}
          </div>
          <p className="assistant-mode-description">
            {aiMode
              ? "AI mode sends your business profile, catalog, owner instructions, and recent conversation to the server-configured AI provider."
              : "Local demo uses simple profile-based answers in this browser and does not call an AI service."}
          </p>
          {!assistantStatus.checking && !assistantStatus.configured && <p className="assistant-config-hint">To enable AI, configure AI_API_URL and AI_MODEL on the server. Hosted endpoints also require a server-side AI_API_KEY. See .env.example.</p>}

          <label className="bb-field assistant-instructions">
            Owner instructions for the chatbot
            <textarea
              value={data.assistantInstructions || ""}
              onChange={updateAssistantInstructions}
              maxLength="2000"
              rows="3"
              placeholder="For example: Use a warm, concise tone. Direct wholesale questions to our sales email."
            />
            <small>Use this for tone and focus. The assistant still must not invent information.</small>
          </label>
        </section>

        <section className="assistant-chat-card" aria-label="Customer chat">
          <header className="assistant-chat-header">
            <div><span className="assistant-status-dot" /><div><strong>{business.name || "Business assistant"}</strong><small>{aiMode ? "AI powered" : "Local demo"}</small></div></div>
            <button className="clear-chat-button" type="button" onClick={clearAssistantChat} disabled={chatLoading || chatMessages.length === 0}>Clear chat</button>
          </header>
          <div className="assistant-messages" aria-live="polite" aria-relevant="additions text">
            {chatMessages.length === 0 && <div className="assistant-welcome"><span className="assistant-welcome-icon">✳</span><h2>Welcome to {business.name || "our business"}</h2><p>Ask about products, services, prices, hours, location, or how to get in touch.</p></div>}
            {chatMessages.map((message) => (
              <article className={`chat-message ${message.role}`} key={message.id}>
                <span>{message.role === "user" ? "You" : "Assistant"}</span>
                <p>{message.content}</p>
              </article>
            ))}
            {chatLoading && <div className="chat-message assistant loading-message"><span>Assistant</span><p><i /> <i /> <i /> <small>{aiMode ? "Thinking…" : "Looking through the profile…"}</small></p></div>}
            <div ref={chatEndRef} />
          </div>
          {chatError && <p className="assistant-error" role="alert">{chatError}</p>}
          <form className="assistant-composer" onSubmit={sendAssistantMessage}>
            <textarea
              value={chatDraft}
              onChange={(event) => setChatDraft(event.target.value.slice(0, 3000))}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
              maxLength="3000"
              rows="2"
              aria-label="Your message"
              placeholder="Ask a question about this business…"
              disabled={chatLoading}
            />
            <button type="submit" disabled={chatLoading || !chatDraft.trim()}>{chatLoading ? "Sending…" : "Send ↑"}</button>
          </form>
          <p className="assistant-footnote">Chat history is saved {supabaseConfigured && session ? "with your cloud account" : "on this device"}. AI mode may send chat and business details to the configured provider.</p>
        </section>
      </section>
    );
  };

  const renderCustomers = () => {
    const formatAddedDate = (value) => {
      const timestamp = Date.parse(value || "");
      return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(timestamp) : "—";
    };

    return (
      <section className="profile-page customers-page">
        <div className="customer-page-heading">
          <div><p className="eyebrow">CUSTOMER MANAGEMENT</p><h1>Your customer CRM.</h1><p className="subtext">Keep customer details organized, searchable, and saved {supabaseConfigured && session ? "to your account" : "in this browser"}.</p></div>
          <button type="button" className="customer-export-button" onClick={exportCustomers} disabled={data.customers.length === 0}>Export CSV ↓</button>
        </div>

        <div className="customer-stats" aria-label="Customer statistics">
          <article><span className="stat-icon total">♙</span><div><strong>{customerStats.total}</strong><span>Total customers</span></div></article>
          <article><span className="stat-icon active">✓</span><div><strong>{customerStats.active}</strong><span>Active</span></div></article>
          <article><span className="stat-icon lead">✳</span><div><strong>{customerStats.leads}</strong><span>Leads</span></div></article>
          <article><span className="stat-icon inactive">○</span><div><strong>{customerStats.inactive}</strong><span>Inactive</span></div></article>
        </div>

        <section className="customer-form-card">
          <div className="customer-form-heading">
            <div><h2>{editingCustomerId ? "Edit customer" : "Add a customer"}</h2><p>{editingCustomerId ? "Update this customer’s details." : "Add a person or business to your customer list."}</p></div>
            {editingCustomerId && <button className="customer-cancel-top" type="button" onClick={cancelCustomerEdit}>Cancel edit</button>}
          </div>
          <form className="profile-form customer-form" onSubmit={saveCustomer} noValidate>
            {field("Customer name *", "name", customer.name, updateCustomer, "Full name", "text", 120)}
            {field("Phone", "phone", customer.phone, updateCustomer, "Include country code if useful", "tel", 40)}
            {field("Email", "email", customer.email, updateCustomer, "name@example.com", "text", 160)}
            {field("Business / company", "company", customer.company, updateCustomer, "Company name", "text", 120)}
            <label className="bb-field">
              Status
              <select name="status" value={customer.status} onChange={updateCustomer}>
                {customerStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
            <label className="bb-field customer-notes-field">
              Notes
              <textarea name="notes" value={customer.notes} onChange={updateCustomer} maxLength="2000" rows="3" placeholder="Useful context, preferences, or follow-up notes" />
            </label>
            {customerError && <p className="customer-form-error" role="alert">{customerError}</p>}
            {customerNotice && <p className="customer-form-notice" role="status">{customerNotice}</p>}
            <div className="customer-form-actions">
              <button type="submit">{editingCustomerId ? "Save changes" : "Add customer"}</button>
              {editingCustomerId && <button className="customer-secondary-button" type="button" onClick={cancelCustomerEdit}>Cancel</button>}
            </div>
          </form>
        </section>

        <section className="customer-list-section" aria-labelledby="customer-list-title">
          <div className="customer-list-heading"><div><h2 id="customer-list-title">Customers</h2><p>{visibleCustomers.length} shown · {data.customers.length} total</p></div></div>
          <div className="customer-toolbar">
            <label className="customer-search">
              <span aria-hidden="true">⌕</span>
              <input value={customerSearch} onChange={(event) => setCustomerSearch(event.target.value)} placeholder="Search name, phone, or email" aria-label="Search customers by name, phone, or email" />
            </label>
            <label className="customer-filter">Status
              <select value={customerStatusFilter} onChange={(event) => setCustomerStatusFilter(event.target.value)}>
                <option>All</option>{customerStatuses.map((status) => <option key={status}>{status}</option>)}
              </select>
            </label>
            <label className="customer-filter">Sort by
              <select value={customerSort} onChange={(event) => setCustomerSort(event.target.value)}>
                <option value="recent">Recently added</option><option value="name">Name A–Z</option>
              </select>
            </label>
          </div>

          {visibleCustomers.length === 0 ? (
            <div className="customer-empty"><span>♙</span><h3>{data.customers.length ? "No matching customers" : "Your customer list is ready"}</h3><p>{data.customers.length ? "Try a different search or status filter." : "Add your first customer above. Your records will be saved in this browser."}</p></div>
          ) : <>
            <div className="customer-table-wrap">
              <table className="customer-table">
                <thead><tr><th>Customer</th><th>Phone</th><th>Email</th><th>Company</th><th>Status</th><th>Added</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>{visibleCustomers.map((item) => (
                  <tr key={item.id}>
                    <td><strong>{item.name}</strong>{item.notes && <small className="customer-note-preview">{item.notes}</small>}</td>
                    <td>{item.phone || "—"}</td><td>{item.email || "—"}</td><td>{item.company || "—"}</td>
                    <td><span className={`customer-status status-${item.status.toLowerCase()}`}>{item.status}</span></td>
                    <td>{formatAddedDate(item.createdAt)}</td>
                    <td><div className="customer-row-actions"><button type="button" onClick={() => editCustomer(item)}>Edit</button><button type="button" onClick={() => deleteCustomer(item.id)}>Delete</button></div></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="customer-card-list">{visibleCustomers.map((item) => (
              <article className="customer-mobile-card" key={item.id}>
                <div className="customer-card-top"><div><h3>{item.name}</h3>{item.company && <p>{item.company}</p>}</div><span className={`customer-status status-${item.status.toLowerCase()}`}>{item.status}</span></div>
                <dl>
                  <div><dt>Phone</dt><dd>{item.phone || "—"}</dd></div>
                  <div><dt>Email</dt><dd>{item.email || "—"}</dd></div>
                  <div><dt>Added</dt><dd>{formatAddedDate(item.createdAt)}</dd></div>
                </dl>
                {item.notes && <p className="customer-card-notes">{item.notes}</p>}
                <div className="customer-row-actions"><button type="button" onClick={() => editCustomer(item)}>Edit</button><button type="button" onClick={() => deleteCustomer(item.id)}>Delete</button></div>
              </article>
            ))}</div>
          </>}
        </section>
      </section>
    );
  };

  const renderSettings = () => (
    <section className="profile-page settings-page">
      <p className="eyebrow">WORKSPACE SETTINGS</p>
      <h1>Business settings.</h1>
      <p className="subtext">Manage preferences, see where your data is stored, and keep a portable backup of your work.</p>

      {supabaseConfigured && session && <section className="settings-card cloud-settings-card">
        <div className="settings-card-heading"><span className="settings-icon cloud">☁</span><div><h2>Cloud account</h2><p>Signed in as {session.user.email || "your account"}. Your business data is protected by Supabase row-level security.</p></div></div>
        <p className={`cloud-sync-status ${cloudStatus.state}`} role={cloudStatus.state === "error" ? "alert" : "status"}>{cloudStatus.message}</p>
        {cloudChoiceRequired && <div className="cloud-migration-choice">
          <h3>Choose what to do with this browser’s saved work</h3>
          <p>Your account is empty, and this browser has saved BizBuddy data. It has not been uploaded. Copy it to your account, or start with a blank cloud workspace. Either choice keeps the current browser copy until you clear it yourself.</p>
          <div className="backup-actions">
            <button type="button" className="settings-primary-button" onClick={migrateLocalWorkspace} disabled={migrationBusy}>{migrationBusy ? "Copying…" : "Copy local data to cloud"}</button>
            <button type="button" className="settings-secondary-button" onClick={() => { setCloudChoiceRequired(false); setCloudReady(true); setCloudStatus({ state: "ready", message: "Started an empty cloud workspace. Your local browser data remains unchanged." }); }}>Start with empty cloud data</button>
          </div>
        </div>}
        {!cloudChoiceRequired && cloudHasData && localDataPresent && <p className="cloud-local-copy-note">A browser copy also exists on this device. Cloud sign-in does not remove or automatically merge that copy.</p>}
        <button type="button" className="settings-secondary-button cloud-signout" onClick={signOut}>Sign out</button>
      </section>}
      {supabasePartiallyConfigured && <p className="settings-message error" role="alert">Supabase configuration is incomplete. Set both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable accounts; the app is currently using local demo mode.</p>}

      <section className="settings-card">
        <div className="settings-card-heading"><span className="settings-icon">⚙</span><div><h2>Business preferences</h2><p>These values are shared with your website, catalog, and assistant tools.</p></div></div>
        <div className="settings-preference-grid">
          {input("Business category", "type", "e.g. Retail, consulting, restaurant")}
          {input("Preferred language", "language", "e.g. English, Spanish")}
          {input("Currency", "currency", "e.g. USD, EUR, INR")}
        </div>
        <p className="settings-autosave-note">{supabaseConfigured && session ? "Changes save to your signed-in cloud account." : "Changes save automatically to the local browser profile."}</p>
      </section>

      <section className="settings-card local-data-card">
        <div className="settings-card-heading"><span className="settings-icon data">▤</span><div><h2>Data stored on this device</h2><p>The storage location depends on the mode shown in your workspace header.</p></div></div>
        <p className="settings-storage-description">{supabaseConfigured && session ? "The signed-in workspace is stored in Supabase. Any browser copy remains local until you explicitly copy it to an empty cloud account." : "Local demo mode stores this information in the current browser only; it is not synced to an account."}</p>
        <ul className="local-data-list">
          <li><span><strong>Business profile</strong><small>Business name, category, country, currency, language, contact details, address, hours, and description.</small></span><b>{supabaseConfigured && session ? "Cloud" : "Local"}</b></li>
          <li><span><strong>Customers</strong><small>Names, contact details, company, notes, status, and dates.</small></span><b>{data.customers.length} records</b></li>
          <li><span><strong>Products and services</strong><small>Catalog names, prices, descriptions, and product URLs.</small></span><b>{data.products.length} records</b></li>
          <li><span><strong>Poster Maker settings</strong><small>Poster text, template, colors, layout controls, and any uploaded poster image.</small></span><b>{supabaseConfigured && session ? "Cloud" : "Local"}</b></li>
          <li><span><strong>Customer Assistant</strong><small>Owner instructions and saved conversation history.</small></span><b>{chatMessages.length} messages</b></li>
        </ul>
        <div className="storage-key-note">Browser storage keys: <code>bizbuddy-data</code> and <code>bizbuddy-assistant-chat</code></div>
      </section>

      <section className="settings-card backup-card">
        <div className="settings-card-heading"><span className="settings-icon backup">⇩</span><div><h2>Backup and restore</h2><p>Export your profile, customers, products, poster and assistant settings, and chat history as a JSON file.</p></div></div>
        <div className="backup-actions">
          <button type="button" className="settings-primary-button" onClick={exportBackup}>Export JSON backup ↓</button>
          <label className="settings-secondary-button">Import JSON backup<input type="file" accept=".json,application/json" onChange={importBackup} /></label>
        </div>
        {backupStatus.error && <p className="settings-message error" role="alert">{backupStatus.error}</p>}
        {backupStatus.success && <p className="settings-message success" role="status">{backupStatus.success}</p>}
        <p className="backup-privacy-note">Keep backup files somewhere private. They may contain customer contact details and notes.</p>
      </section>

      <section className="settings-card settings-danger-card">
        <div><h2>Clear all BizBuddy data</h2><p>Remove business profile data, products, customers, poster settings, assistant instructions, and chat history from this browser.</p></div>
        <button type="button" onClick={clearAllLocalData}>Clear all local data</button>
      </section>
    </section>
  );

  const page = {
    Dashboard: renderDashboard,
    "My Business": renderBusiness,
    "Website Builder": renderWebsiteBuilder,
    "QR Catalog": renderCatalog,
    "Poster Maker": renderPosterMaker,
    "Customer Assistant": renderAssistant,
    Customers: renderCustomers,
    Settings: renderSettings,
  };

  if (supabaseConfigured && authLoading) return <main className="auth-screen"><section className="auth-card" role="status"><span className="auth-mark">B</span><h1>Connecting securely</h1><p>Checking your BizBuddy account session…</p></section></main>;

  if (supabaseConfigured && !session) return <main className="auth-screen">
    <section className="auth-card">
      <span className="auth-mark">B</span>
      <p className="eyebrow">BIZBUDDY AI · CLOUD</p>
      <h1>{authMode === "signup" ? "Create your account." : "Welcome back."}</h1>
      <p className="subtext">Sign in to access your private business workspace, customers, products, and saved settings.</p>
      <form className="profile-form auth-form" onSubmit={submitAuth}>
        <label className="bb-field">Email address<input type="email" autoComplete="email" required value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} /></label>
        <label className="bb-field">Password<input type="password" autoComplete={authMode === "signup" ? "new-password" : "current-password"} minLength="8" required value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} /></label>
        <button type="submit" disabled={!supabaseClient}>{authMode === "signup" ? "Create account" : "Log in"}</button>
      </form>
      {authError && <p className="settings-message error" role="alert">{authError}</p>}
      {!supabaseClient && !authLoading && authError && <button type="button" className="settings-secondary-button" onClick={() => { setAuthError(""); setAuthLoading(true); setAuthInitAttempt((attempt) => attempt + 1); }}>Retry Supabase connection</button>}
      {authNotice && <p className="settings-message success" role="status">{authNotice}</p>}
      <p className="auth-switch">{authMode === "signup" ? "Already have an account?" : "New to BizBuddy?"} <button type="button" onClick={() => { setAuthMode(authMode === "signup" ? "login" : "signup"); setAuthError(""); setAuthNotice(""); }}>{authMode === "signup" ? "Log in" : "Create an account"}</button></p>
      <p className="auth-security-note">This app uses your Supabase anon key and row-level security. No service-role key is used in the browser.</p>
    </section>
  </main>;

  if (supabaseConfigured && session && !cloudReady) return <main className="auth-screen"><section className="auth-card cloud-choice-card">
    <span className="auth-mark">B</span>
    <p className="eyebrow">PRIVATE CLOUD WORKSPACE</p>
    <h1>{cloudChoiceRequired ? "Your cloud account is ready." : cloudStatus.state === "error" ? "We couldn’t load your workspace." : "Loading your workspace…"}</h1>
    <p className="subtext">{cloudChoiceRequired ? "There is existing BizBuddy data in this browser and no data in this account yet. Choose whether to copy it. Your local data will not be removed." : cloudStatus.state === "error" ? cloudStatus.message : "Loading your secure cloud workspace…"}</p>
    {cloudChoiceRequired && <div className="backup-actions auth-choice-actions">
      <button type="button" className="settings-primary-button" disabled={migrationBusy} onClick={migrateLocalWorkspace}>{migrationBusy ? "Copying…" : "Copy local data to cloud"}</button>
      <button type="button" className="settings-secondary-button" onClick={() => { setCloudChoiceRequired(false); setCloudReady(true); setCloudStatus({ state: "ready", message: "Started an empty cloud workspace. Your local browser data remains unchanged." }); }}>Start with empty cloud data</button>
    </div>}
    {cloudStatus.state === "error" && <button type="button" className="settings-secondary-button" onClick={reloadCloudWorkspace}>Retry loading</button>}
    <button type="button" className="auth-text-button" onClick={signOut}>Sign out</button>
    {authError && <p className="settings-message error" role="alert">{authError}</p>}
  </section></main>;

  return (
    <div className="app">
      <aside className="sidebar" aria-label="Main navigation">
        <h2 className="logo">✦ BizBuddy<span> AI</span></h2>
        <p className="menu-label">WORKSPACE</p>

        {navItems.map(([item, icon]) => (
          <button
            className={active === item ? "nav active" : "nav"}
            type="button"
            aria-current={active === item ? "page" : undefined}
            onClick={() => setActive(item)}
            key={item}
          >
            <span>{icon}</span> {item}
          </button>
        ))}

        <div className="sidebar-bottom">Made for small businesses ❤️</div>
      </aside>

      <main className="main">
        <header className="topbar">
          <span>Workspace / {active}</span>
          <div className="topbar-account">
            <span className={`free-badge ${supabaseConfigured && session ? "cloud-mode-badge" : "demo-mode-badge"}`}>{supabaseConfigured && session ? "CLOUD MODE" : "LOCAL DEMO"}</span>
            {supabaseConfigured && session && <button type="button" className="topbar-signout" onClick={signOut}>Sign out</button>}
          </div>
        </header>

        {page[active] ? page[active]() : renderDashboard()}
      </main>
    </div>
  );
}
