import logger from './logger';
import * as SQS from 'aws-sdk/clients/sqs';
import { DeleteMessageBatchRequest, DeleteMessageBatchRequestEntryList } from 'aws-sdk/clients/sqs';

export type Message = SQS.Types.Message;
export type MessageHandler = (message: Message) => Promise<void>;
export type TimerFn = () => number;

export default class QueueDrainer {
  private sqs: SQS;
  private queueUrl: string;
  private handleMessage: MessageHandler;
  private getRemainingTime: TimerFn;

  constructor({ sqs, queueUrl, handleMessage, getRemainingTime }: { sqs: SQS, queueUrl: string, handleMessage: MessageHandler, getRemainingTime: TimerFn }) {
    this.sqs = sqs;
    this.queueUrl = queueUrl;
    this.handleMessage = handleMessage;
    this.getRemainingTime = getRemainingTime;
  }

  private async poll(numMessages: number = 10): Promise<Message[]> {
    const response = await this.sqs.receiveMessage({
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: numMessages
    }).promise();

    return response.Messages || [];
  }

  private async deleteMessage(message: Message) {
    if (!message.ReceiptHandle) {
      throw new Error('missing receipt handle');
    }

    try {
      await this.sqs.deleteMessage({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle
      }).promise();
    } catch (err) {
      logger.error({ err, message }, 'failed to delete message');
    }
  }

  deleteMessages = async (messages: Message[]) => {
    logger.debug({ messageCount: messages.length }, 'deleting messages');

    const Entries: DeleteMessageBatchRequestEntryList = messages.map(
      ({ MessageId, ReceiptHandle }) => ({
        Id: MessageId,
        ReceiptHandle
      })
    ) as any;

    await this.sqs.deleteMessageBatch({
      QueueUrl: this.queueUrl,
      Entries
    }).promise();

    logger.debug({ messageCount: messages.length }, 'deleted messages');
  };

  processMessages = async (messages: Message[]) => {
    logger.debug({ messageCount: messages.length }, `processing messages`);

    for (let i = 0; i < messages.length; i++) {
      const message: Message = messages[i];
      await this.handleMessage(message);
    }
  };

  public async start() {
    let processedMessageCount = 0;
    let pollCount = 0;

    // while we have more than 3 seconds remaining
    while (this.getRemainingTime() > 3000) {
      if (pollCount % 5 === 0) {
        logger.info({ pollCount, processedMessageCount }, 'polling...');
      } else {
        logger.debug({ pollCount, processedMessageCount }, 'polling...');
      }

      const messages = await this.poll();

      await this.processMessages(messages);

      await this.deleteMessages(messages);

      processedMessageCount += messages.length;

      pollCount++;
    }

    logger.debug({ processedMessageCount, pollCount }, 'finished draining queue');
  }
}
