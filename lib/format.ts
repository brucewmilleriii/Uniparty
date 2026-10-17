import type { Member, PartyCode } from "@/lib/types";

export const STATES: Record<string, string> = {AL:"Alabama",AK:"Alaska",AS:"American Samoa",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",GU:"Guam",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",MP:"Northern Mariana Islands",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",PR:"Puerto Rico",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VI:"U.S. Virgin Islands",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"};

export const PARTY: Record<PartyCode, string> = { D: "Democrat", R: "Republican", I: "Independent" };

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(s: string | null | undefined): string {
  if (!s) return "";
  const p = s.slice(0, 10).split("-");
  if (p.length === 1) return p[0];
  if (p.length === 2) return `${MON[+p[1] - 1]} ${p[0]}`;
  return `${MON[+p[1] - 1]} ${+p[2]}, ${p[0]}`;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Compact seat label: "MA" for senators, "CA-17" or "WY-AL" for House members. */
export function seatLabel(m: Member): string {
  if (m.chamber === "senate") return m.state;
  return m.district ? `${m.state}-${m.district}` : `${m.state}-AL`;
}

export function roleTitle(m: Member): string {
  const state = STATES[m.state] ?? m.state;
  if (m.chamber === "senate") return `${m.state} Senator`;
  return m.district ? `${state}’s ${ordinal(m.district)} District` : `${state} at-large`;
}

export function ageOn(birthday: string | null, now: Date): number | null {
  if (!birthday) return null;
  const [y, mo, d] = birthday.split("-").map(Number);
  let a = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d)) a--;
  return a;
}

export function sourceLinks(m: Member) {
  const fec = m.fecIds[0] ? `https://www.fec.gov/data/candidate/${m.fecIds[0]}/` : "https://www.fec.gov/data/";
  return {
    bio: `https://bioguide.congress.gov/search/bio/${m.bioguideId}`,
    fec,
    disclosures: m.chamber === "house" ? "https://disclosures-clerk.house.gov/FinancialDisclosure" : "https://efdsearch.senate.gov/search/",
    votes: m.chamber === "house" ? "https://clerk.house.gov/Votes" : "https://www.senate.gov/legislative/votes_new.htm",
    bills: `https://www.congress.gov/member/${m.bioguideId}`,
  };
}
