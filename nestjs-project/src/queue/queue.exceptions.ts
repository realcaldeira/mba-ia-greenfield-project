import { DomainException } from '../common/exceptions/domain.exception';

export class QueueUnavailableException extends DomainException {
  constructor() {
    super('QUEUE_UNAVAILABLE', 503, 'Processing queue is unavailable');
  }
}
