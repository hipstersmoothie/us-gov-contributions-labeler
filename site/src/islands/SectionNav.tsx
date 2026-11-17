// The header's section nav: a menu per group (Members, Money, Influence),
// then plain links. Until it hydrates, and without JS, each group is a link
// to its first page instead of a menu button, so every group goes somewhere;
// the footer's site map links every section.
//
// A Menu, not a Dialog of links: it gives the arrow keys, typeahead, Escape
// and focus back on the trigger, and its items are still real links (MenuItem
// href), so they open in a new tab and show their URL like any other.
import { useEffect, useState, type AnchorHTMLAttributes } from "react";
import { Button, Menu, MenuItem, MenuTrigger, Popover, Text } from "react-aria-components";
import { NAV_LINKS, navGroups } from "../lib/nav";

interface Props {
  /** The latest election year, for the races item. */
  year: number;
  /** The href of the section the page is in, if any. */
  current?: string;
}

const Chevron = () => (
  <svg className="chevron" viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
    <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

export default function SectionNav({ year, current }: Props) {
  const groups = navGroups(year);
  // The server's HTML has the links; the menus take their place once React runs.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  return (
    <ul className="wrap">
      {groups.map((g) => {
        const active = g.items.some((i) => i.href === current);
        return (
          <li key={g.label}>
            {hydrated ? (
              <MenuTrigger>
                <Button className="section-link" data-current={active || undefined}>
                  {g.label}
                  <Chevron />
                </Button>
                <Popover className="nav-popover" placement="bottom start" offset={1}>
                  <Menu className="nav-menu" items={g.items}>
                    {(i) => (
                      <MenuItem
                        id={i.href}
                        href={i.href}
                        textValue={i.label}
                        className="nav-item"
                        // MenuItem passes no aria-current through, so the page's own item renders its link itself.
                        render={i.href === current ? (props) => <a {...(props as AnchorHTMLAttributes<HTMLAnchorElement>)} aria-current="page" /> : undefined}
                      >
                        <Text slot="label" className="nav-label">{i.label}</Text>
                        <Text slot="description" className="nav-note">{i.note}</Text>
                      </MenuItem>
                    )}
                  </Menu>
                </Popover>
              </MenuTrigger>
            ) : (
              <a className="section-link" href={g.href} data-current={active || undefined}>
                {g.label}
                <Chevron />
              </a>
            )}
          </li>
        );
      })}
      {NAV_LINKS.map((l) => (
        <li key={l.href}>
          <a className="section-link" href={l.href} aria-current={l.href === current ? "page" : undefined}>
            {l.label}
          </a>
        </li>
      ))}
    </ul>
  );
}
