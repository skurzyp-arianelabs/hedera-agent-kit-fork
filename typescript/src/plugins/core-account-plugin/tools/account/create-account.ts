import { z } from 'zod';
import type { Context } from '@/shared/configuration';
import type { Tool } from '@/shared/tools';
import { Client, LedgerId, PrivateKey } from '@hashgraph/sdk';
import { handleTransaction, RawTransactionResponse } from '@/shared/strategies/tx-mode-strategy';
import HederaBuilder from '@/shared/hedera-utils/hedera-builder';
import { createAccountParameters } from '@/shared/parameter-schemas/has.zod';
import HederaParameterNormaliser from '@/shared/hedera-utils/hedera-parameter-normaliser';
import { PromptGenerator } from '@/shared/utils/prompt-generator';

const AGREEMENT_TEXT = 'I understand that this action can be risky.';

const createAccountPrompt = (context: Context = {}) => {
  const contextSnippet = PromptGenerator.getContextSnippet(context);
  const usageInstructions = PromptGenerator.getParameterUsageInstructions();

  return `
${contextSnippet}

This tool will create a new Hedera account with a newly generated key.

IMPORTANT: This is a sensitive action. To proceed, you must include the exact agreement string.

Parameters:
- agreement (string, required): Must be exactly: "${AGREEMENT_TEXT}"
- keyType (enum, required): One of: ECDSA | ED25519. Determines the key type to generate for the account
- accountMemo (string, optional): Optional memo for the account
- initialBalance (number, optional, default 0): Initial HBAR to fund the account
- maxAutomaticTokenAssociations (number, optional, default -1): -1 means unlimited
${usageInstructions}
`;
};

const createAccount = async (
  client: Client,
  context: Context,
  params: z.infer<ReturnType<typeof createAccountParameters>>,
) => {
  try {
    // Block on mainnet
    if (client.ledgerId === LedgerId.MAINNET) {
      return 'This action is not currently supported on the mainnet.';
    }

    // Validate agreement
    if (params.agreement !== AGREEMENT_TEXT) {
      return 'The agreement must match exactly: "I understand that this action can be risky."';
    }

    // Generate key pair
    const privKey =
      params.keyType === 'ECDSA'
        ? PrivateKey.generateECDSA()
        : PrivateKey.generateED25519();
    const pubKey = privKey.publicKey.toStringDer();

    // Normalise params to match AccountCreateTransaction props
    const normalisedParams = HederaParameterNormaliser.normaliseCreateAccount(
      params,
      context,
      client,
      pubKey,
    );

    // Build transaction
    const tx = HederaBuilder.createAccount(normalisedParams);

    // Define a post-process to include keys
    const postProcess = (response: RawTransactionResponse) => {
      const accountIdStr = response.accountId ? response.accountId.toString() : 'unknown';
      return `Account created successfully.\nTransaction ID: ${response.transactionId}\nNew Account ID: ${accountIdStr}\nPublic Key (DER): ${pubKey}\nPrivate Key (DER): ${privKey.toStringDer()}`;
    };

    const result = await handleTransaction(tx, client, context, postProcess);
    return result;
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    return 'Failed to create account';
  }
};

export const CREATE_ACCOUNT_TOOL = 'create_account_tool';

const tool = (context: Context): Tool => ({
  method: CREATE_ACCOUNT_TOOL,
  name: 'Create Account',
  description: createAccountPrompt(context),
  parameters: createAccountParameters(context),
  execute: createAccount,
});

export default tool;
