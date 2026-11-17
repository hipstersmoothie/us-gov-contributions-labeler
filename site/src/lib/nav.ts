// The site's sections: three menus in the header (SectionNav), two plain
// links beside them, and the same groups as the footer's site map. The
// SectionNav island bundles this, so it imports nothing.

export interface NavItem {
  href: string;
  label: string;
  /** One line under the label in the header menu. */
  note?: string;
  /** Path prefixes that count as this section, if not just href. */
  match?: string[];
}
export interface NavGroup {
  label: string;
  /** Where the menu's trigger goes before the menu hydrates, or without JS. */
  href: string;
  items: NavItem[];
}

/** The groups, with the races item for the latest election year (lib/races latestYear). */
export const navGroups = (latestYear: number): NavGroup[] => [
  {
    label: "Members",
    href: "/members/",
    items: [
      { href: "/members/", label: "All members", note: "What every member raised, and from whom", match: ["/members/", "/states/"] },
      { href: "/find/", label: "Find your members", note: "Your representative and senators by ZIP" },
      {
        href: `/races/${latestYear}/`,
        label: `${latestYear} races`,
        note: "Every House and Senate race and its candidates",
        match: ["/races/", "/candidates/"],
      },
      { href: "/committees/", label: "Committees", note: "Who sits on each committee, and who funds them" },
      { href: "/holdings/", label: "Investments", note: "The stocks members own and trade" },
    ],
  },
  {
    label: "Money",
    href: "/sectors/",
    items: [
      { href: "/sectors/", label: "Sectors", note: "PAC money by industry" },
      {
        href: "/organizations/",
        label: "Organizations",
        note: "Companies, unions and groups behind PACs",
        match: ["/organizations/", "/pacs/"],
      },
      { href: "/donors/", label: "Big donors", note: "Who funds the super PACs" },
      { href: "/bundling/", label: "Bundling", note: "Contributions lobbyists gathered for members" },
    ],
  },
  {
    label: "Influence",
    href: "/revolving-door/",
    items: [
      { href: "/revolving-door/", label: "Revolving door", note: "Former staff who now lobby" },
      { href: "/foreign-lobbying/", label: "Foreign lobbying", note: "Agents of foreign governments and companies" },
      { href: "/travel/", label: "Sponsored travel", note: "Trips paid for by outside groups" },
    ],
  },
];

export const NAV_LINKS: NavItem[] = [
  { href: "/bills/", label: "Bills" },
  { href: "/bluesky/", label: "On Bluesky" },
];

/** The footer's fourth column: the header's two links, then the site's own pages. */
export const MORE_LINKS: NavItem[] = [
  ...NAV_LINKS,
  { href: "/about/", label: "How this data works" },
  { href: "/open-data/", label: "Open data" },
  { href: "/mcp/", label: "AI assistants" },
];

export const isCurrent = (item: NavItem, path: string) => (item.match ?? [item.href]).some((p) => path.startsWith(p));
