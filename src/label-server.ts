import {
  getLabelerLabelDefinitions,
  setLabelerLabelDefinitions,
} from "@skyware/labeler/scripts";
import { DID, PORT, SIGNING_KEY } from "./constants.js";
import { LabelerServer } from "@skyware/labeler";

const server = new LabelerServer({
  did: DID,
  signingKey: SIGNING_KEY,
  dbPath: process.env.DB_PATH ?? "labels.db",
});

server.app.listen({ port: PORT, host: "::" }, (error, address) => {
  if (error) console.error(error);
  else console.log(`Labeler server listening on ${address}`);
});

const credentials = {
  identifier: DID,
  password: process.env.LABELER_PASSWORD!,
};

interface Label {
  name: string;
  description: string;
}

const numbers = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

function getIdentifier(name: string) {
  // GitHub allows [A-Za-z0-9_.-]+ but bsky only supports ^[a-z-]+$
  let identifier = name
    .replaceAll(/[/._\s&,'"!@#$%^*()+={}\[\]:;<>?~`]/g, "-")
    // Convert to lowercase
    .toLowerCase();

  // replace numbers with the corresponding string representation
  for (let i = 0; i < numbers.length; i++) {
    const number = numbers[i];

    if (number && identifier.includes(`${i}`)) {
      identifier = identifier.replaceAll(`${i}`, number);
    }
  }

  return identifier;
}

async function createLabel({ name, description }: Label) {
  const identifier = getIdentifier(name);
  const currentLabels = (await getLabelerLabelDefinitions(credentials)) || [];

  if (currentLabels.find((label) => label.identifier === identifier)) {
    console.log(`Label ${identifier} already exists`);
    return;
  }

  await setLabelerLabelDefinitions(credentials, [
    ...currentLabels,
    {
      identifier,
      severity: "inform",
      blurs: "none",
      defaultSetting: "warn",
      adultOnly: false,
      locales: [{ lang: "en", description, name }],
    },
  ]);

  console.log(`Created label ${identifier}!`);
}

export const addUserLabel = async (did: string, label: Label) => {
  const identifier = getIdentifier(label.name);

  await createLabel(label);

  try {
    server.createLabel({ uri: did, val: identifier });
    console.log(`${new Date().toISOString()} Labeled ${did}: ${identifier}`);
    return true;
  } catch (err) {
    console.error(err);
  }

  return false;
};

interface Session {
  accessJwt: string;
  refreshJwt: string;
}

export const getStoredSession = () => {
  // initialize session table if it doesn't exist
  server.db
    .prepare(
      `CREATE TABLE IF NOT EXISTS session (uri TEXT PRIMARY KEY, accessJwt TEXT, refreshJwt TEXT)`
    )
    .run();

  // TODO: https://github.com/skyware-js/bot/issues/16
  return null as Session | null;
  // return server.db
  //   .prepare<string[]>(`SELECT * FROM session WHERE uri = ?`)
  //   .get(DID) as unknown as Session | null;
};

export const setStoredSession = (session: Session) => {
  server.db
    .prepare(
      `INSERT OR REPLACE INTO session (uri, accessJwt, refreshJwt) VALUES (?, ?, ?)`
    )
    .run(DID, session.accessJwt, session.refreshJwt);
};
