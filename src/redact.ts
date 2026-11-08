// Personal details removed from platform messages as they arrive, so no tool
// returns them unless FEATURES includes personal_info

import { Account, Hub4g, HubNetwork, HubWiFi, MobileDevice, Person, Place, WeatherRadio, WiFi } from "./capabilities.js";

/** Removed wherever they appear */
const PERSONAL_KEYS = new Set<string>([
  // Contact details and whereabouts
  Person.ATTR_EMAIL, Person.ATTR_MOBILENUMBER, Person.ATTR_MOBILENOTIFICATIONENDPOINTS, Person.ATTR_CURRLOCATION,
  MobileDevice.ATTR_PHONENUMBER, MobileDevice.ATTR_NOTIFICATIONTOKEN,
  MobileDevice.ATTR_LASTLATITUDE, MobileDevice.ATTR_LASTLONGITUDE,
  // The home's address and location
  Place.ATTR_STREETADDRESS1, Place.ATTR_STREETADDRESS2, Place.ATTR_CITY, Place.ATTR_STATEPROV,
  Place.ATTR_ZIPCODE, Place.ATTR_ZIPPLUS4, Place.ATTR_ADDRLATITUDE, Place.ATTR_ADDRLONGITUDE,
  Place.ATTR_ADDRCOUNTY, Place.ATTR_ADDRCOUNTYFIPS,
  WeatherRadio.ATTR_LOCATION, HubNetwork.ATTR_EXTERNALIP, HubWiFi.ATTR_WIFIBSSID, WiFi.ATTR_BSSID,
  // The hub's cellular line
  Hub4g.ATTR_PHONENUMBER, Hub4g.ATTR_IMEI, Hub4g.ATTR_IMSI, Hub4g.ATTR_ICCID,
  // Billing
  Account.ATTR_BILLINGFIRSTNAME, Account.ATTR_BILLINGLASTNAME, Account.ATTR_BILLINGCCTYPE, Account.ATTR_BILLINGCCLAST4,
  Account.ATTR_BILLINGSTREET1, Account.ATTR_BILLINGSTREET2, Account.ATTR_BILLINGCITY,
  Account.ATTR_BILLINGSTATE, Account.ATTR_BILLINGZIP, Account.ATTR_BILLINGZIPPLUSFOUR,
  // Unprefixed fields of PlaceAccessDescriptor, Invitation and EmailRecipient
  "streetAddress1", "streetAddress2", "stateProv", "zipCode", "inviteeEmail", "email",
]);

// PlaceAccessDescriptor and StreetAddress also use names too common to remove
// everywhere (state, city), so those go only from records that hold an address
const ADDRESS_MARKERS = ["streetAddress1", "zipCode", "line1", "zip"];
const ADDRESS_KEYS = new Set(["line1", "line2", "city", "state", "zip"]);

/** Copy value without personal details, at any depth */
export function redactPersonal<T>(value: T): T {
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== "object") return value;
  const isAddress = ADDRESS_MARKERS.some((key) => key in value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PERSONAL_KEYS.has(key) && !(isAddress && ADDRESS_KEYS.has(key)))
      .map(([key, v]) => [key, strip(v)])
  );
}
