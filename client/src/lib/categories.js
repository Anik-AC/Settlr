import {
  Home, Zap, Wifi, ShoppingBasket, SprayCan, UtensilsCrossed, TramFront, Ticket,
  Repeat, Sofa, Receipt, ArrowLeftRight, Plane, Heart, Users,
} from 'lucide-react';

export const CATEGORIES = [
  { id: 'rent', label: 'Rent', icon: Home, tone: 'iris' },
  { id: 'utilities', label: 'Utilities', icon: Zap, tone: 'sand' },
  { id: 'internet', label: 'Internet', icon: Wifi, tone: 'sky' },
  { id: 'groceries', label: 'Groceries', icon: ShoppingBasket, tone: 'lime' },
  { id: 'household', label: 'Household', icon: SprayCan, tone: 'mint' },
  { id: 'dining', label: 'Dining', icon: UtensilsCrossed, tone: 'coral' },
  { id: 'transport', label: 'Transport', icon: TramFront, tone: 'sky' },
  { id: 'entertainment', label: 'Fun', icon: Ticket, tone: 'rose' },
  { id: 'subscriptions', label: 'Subscriptions', icon: Repeat, tone: 'iris' },
  { id: 'furniture', label: 'Furniture', icon: Sofa, tone: 'sand' },
  { id: 'general', label: 'Other', icon: Receipt, tone: 'muted' },
];

const BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
const PAYMENT = { id: 'payment', label: 'Payment', icon: ArrowLeftRight, tone: 'lime' };

export const categoryOf = (id) => (id === 'payment' ? PAYMENT : BY_ID[id] || BY_ID.general);

/** Guess a category from the description as the user types. */
const HINTS = [
  [/\brent\b|lease|landlord/i, 'rent'],
  [/hydro|electric|enbridge|gas bill|water|utilit|heat/i, 'utilities'],
  [/internet|wi-?fi|rogers|bell|telus|fido|freedom|teksavvy|phone plan/i, 'internet'],
  [/grocer|costco|no frills|loblaw|metro|sobeys|walmart|food basics|freshco|farm boy|t&t|superstore/i, 'groceries'],
  [/clean|soap|detergent|paper towel|toilet|trash|bags|supplies|filter|bulb|canadian tire|ikea/i, 'household'],
  [/dinner|lunch|breakfast|brunch|restaurant|pizza|cafe|coffee|uber eats|doordash|skip|takeout|bar\b|pub/i, 'dining'],
  [/uber|lyft|ttc|presto|transit|gas station|parking|taxi|train|bus/i, 'transport'],
  [/movie|concert|ticket|game|raptors|leafs|show|party/i, 'entertainment'],
  [/netflix|spotify|disney|prime|crave|youtube|subscription|icloud|apple/i, 'subscriptions'],
  [/sofa|couch|table|chair|desk|bed|mattress|furniture/i, 'furniture'],
];
export function guessCategory(text) {
  for (const [re, id] of HINTS) if (re.test(text)) return id;
  return null;
}

export const GROUP_KINDS = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'trip', label: 'Trip', icon: Plane },
  { id: 'couple', label: 'Couple', icon: Heart },
  { id: 'other', label: 'Other', icon: Users },
];
export const groupKindOf = (id) => GROUP_KINDS.find((k) => k.id === id) || GROUP_KINDS[3];

export const PAYMENT_METHODS = [
  { id: 'etransfer', label: 'e-Transfer' },
  { id: 'cash', label: 'Cash' },
  { id: 'other', label: 'Other' },
];
export const paymentMethodLabel = (id) => PAYMENT_METHODS.find((m) => m.id === id)?.label || 'Payment';
