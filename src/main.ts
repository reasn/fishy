import { DateTime } from "luxon";
import pino from "pino";
import OpenAI from "openai";

import { promisify } from "util";
import { exec } from "child_process";
const execPromise = promisify(exec);

import {
  addLog,
  VariableSet,
  fetchActiveMessages,
  fetchActiveRecipients,
  fetchAuthors,
  fetchCommonPrompts,
  MessageRow,
  RecipientRow,
  updateRecipient,
} from "./sheet";
import { sendSms } from "./sms";

const logger = pino();

const {
  LOOP_REPEAT,
  LOOP_WAIT,
  CANARY,
  RECIPIENT_CAP,
  MAX_WAVE,
  HOT_SEND,
  HOT_UPDATE,
} = process.env;

export default async function main() {
  const openAi = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    dangerouslyAllowBrowser: true,
  });

  //   await updateRecipient(1, 1, "test message", "hallo Alex");
  logger.info("Preparing sendout");
  const now = DateTime.now();
  const hotSend = HOT_SEND === "true";
  const hotUpdate = HOT_UPDATE === "true";

  const prompts = await fetchCommonPrompts();
  let recipients = await fetchActiveRecipients();
  if (CANARY) {
    recipients = recipients.filter((r) => r.number === CANARY);
  }
  if (RECIPIENT_CAP && parseInt(RECIPIENT_CAP) > 0) {
    recipients = recipients.slice(0, parseInt(RECIPIENT_CAP));
  }

  let messages = await fetchActiveMessages();
  if (MAX_WAVE) {
    messages = messages.filter((m) => m.wave <= parseInt(MAX_WAVE || "0"));
  }
  const authors = await fetchAuthors();
  logger.info(
    `Fetched ${recipients.length} recipients ${CANARY ? "(CANARY)" : ""} and ${messages.length
    } messages`
  );

  const loops = parseInt(LOOP_REPEAT || "1");
  for (let i = 0; i < loops; i++) {
    for (const recipient of recipients) {
      // console.log(recipient)
      //console.log(messages)
      const sendable = messages.find(
        (m) =>
          m.wave > recipient.lastWave &&
          (m.highPriority || recipient.highIntensity) &&
          assertCondition(m, recipient)
      );
      if (!sendable) {
        logger.info(
          `Nothing to send to ${recipient.name} (${recipient.number})`
        );
        continue;
      }
      /*const content = wrapWithAuthor(
        await renderMessageContent(sendable, recipient, prompts, openAi),
        sendable,
        authors
      );*/
      const content = await renderMessageContent(sendable, recipient, prompts, openAi);

      logger.info(
        `${hotSend ? "Sending" : "NOT sending"} message ${sendable.handle} to ${recipient.name
        } (${recipient.language}) via ${recipient.messenger}`
      );
      if (hotSend) {
        await send(recipient, content);
      }
      if (hotUpdate) {
        logger.info(
          `Updating ${recipient.rowIndex} (${recipient.number
          }) to ${now.toISO()} with ${sendable.handle}`
        );

        await updateRecipient(
          recipient.rowIndex,
          sendable.wave,
          sendable.handle,
          content
        );
        recipient.lastWave = sendable.wave;

        await addLog(
          recipient.name,
          recipient.number,
          now,
          sendable.handle,
          content
        );
      }
    }
    if (loops > 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, parseInt(LOOP_WAIT || "0"))
      );
    }
  }
}
const assertCondition = (m: MessageRow, recipient: RecipientRow) => {
  const conditions = m.condition?.split(',') || [];
  for (const condition of conditions) {

    if (condition === "slots_unknown" && recipient.slots !== "unknown") {
      return false;
    }
    if (condition === "coming" && (recipient.slots === "unknown" || recipient.slots < 1)) {
      return false;
    }
    if (condition === "not_coming" && (recipient.slots !== 0)) {
      return false;
    }
    if (condition === 'new_to_fishy' && !recipient.tags.includes('new_to_fishy')) {
      return false;
    }
    if (condition === 'knows_fishy' && recipient.tags.includes('new_to_fishy')) {
      return false;
    }
    if(condition=== 'de' && recipient.language !== 'de') {
      return false;
    }
    if(condition=== 'en' && recipient.language !== 'en') {
      return false;
    }
  }

  return true;
};

const send = async (recipient: RecipientRow, content: string) => {
  if (recipient.messenger === "sms") {
    await sendSms(recipient.number, content);
    logger.info("Sent via SMS");
  } else {
    const { stdout, stderr } = await execPromise(
      `${process.env.SIGNAL_CLI} send ${recipient.number
      } -m "${content.replaceAll('"', "'")}"`
    );
    if (
      stderr &&
      stderr !==
      `SLF4J(I): Connected with provider of type [ch.qos.logback.classic.spi.LogbackServiceProvider]
INFO  AccountHelper - The Signal protocol expects that incoming messages are regularly received.
` &&
      stderr !==
      `SLF4J(I): Connected with provider of type [ch.qos.logback.classic.spi.LogbackServiceProvider]
INFO  AccountHelper - The Signal protocol expects that incoming messages are regularly received.
WARN  RefreshRecipientsJob - Full CDSI recipients refresh failed, ignoring: org.signal.libsignal.net.NetworkProtocolException: HTTP error: 404 Not Found (IOException)
`
    ) {
      console.log(stderr);
      console.log("pups");
      throw new Error(stderr);
    }
    logger.info("Sent via Signal");

    //        console.log("stderr:", stderr);
  }
};

const wrapWithAuthor = (
  content: string,
  sendable: MessageRow,
  authors: string[]
) => {
  content = `🐙\n${content}`;
  if (sendable.handle === "invite" || sendable.handle == "bot-intro") {
    return content;
  }
  return `${content}\n\n${authors[Math.floor(Math.random() * authors.length)]}`;
};

const renderMessageContent = async (
  message: MessageRow,
  recipient: RecipientRow,
  variables: VariableSet,
  openAi: OpenAI
) => {
  const timeLeft = DateTime.fromISO("2024-12-07T12:00:00").diffNow();
  const valueMap = {
    name: recipient.name,
    weeks: Math.round(timeLeft.as("weeks")).toLocaleString(),
    days: Math.round(timeLeft.as("days")).toLocaleString(),
    seconds: Math.round(timeLeft.as("seconds")).toLocaleString(),
    hours: Math.round(timeLeft.as("hours")).toLocaleString(),
    tags: recipient.tags.join(','),
    slots_recipient:
      recipient.slots === "unknown"
        ? "unknown"
        : recipient.slots.toLocaleString(),
    additional_slots_recipient:
      recipient.slots === "unknown"
        ? "unknown"
        : Math.max(0, recipient.slots - 1).toLocaleString(),
    slots_left: `${variables.slots_left}`,
    slots_confirmed: `${variables.slots_confirmed}`,
    slots_unknown: `${variables.slots_unknown}`,
  };

  let templated = message.content;

  for (const key in valueMap) {
    templated = templated.replaceAll(`{${key}}`, valueMap[key]);
  }

  if (message.type === "template") {
    return templated;
  }

  if (recipient.language === "de") {
    templated = `You respond in German. ${templated}`;
  }
  if (recipient.language === "it") {
    templated = `You respond in Italian. ${templated}`;
  }
  if (recipient.language === "fr") {
    templated = `You respond in French. ${templated}`;
  }
  if (recipient.language === "es") {
    templated = `You respond in Spanish. ${templated}`;
  }

  const completion = await openAi.beta.chat.completions.parse({
    messages: [
      {
        role: "system",
        content: variables.system_prompt,
      },
      {
        role: "user",
        content: templated,
      },
    ],
    model: "gpt-4o-2024-08-06",
    // model: "gpt-3.5-turbo",
    //"gpt-4o-mini-2024-07-18",
    // temperature: 1,
  });

  if (!completion.choices[0].message.content) {
    logger.info(completion);
    throw new Error();
  }
  return completion.choices[0].message.content;
};
