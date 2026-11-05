import { DomainException } from '../common/exceptions/domain.exception';

// Every registration creates the user's channel; a user without one is an
// inconsistent account, answered as 404 instead of a 500.
export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'Channel not found');
  }
}
