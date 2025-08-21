// optional to use methods in here

import {
  airdropFungibleTokenParameters,
  createFungibleTokenParameters,
  createFungibleTokenParametersNormalised,
  createNonFungibleTokenParameters,
  createNonFungibleTokenParametersNormalised,
  mintFungibleTokenParameters,
  mintNonFungibleTokenParameters,
} from '@/shared/parameter-schemas/hts.zod';
import { transferHbarParameters } from '@/shared/parameter-schemas/has.zod';
import {
  createTopicParameters,
  createTopicParametersNormalised,
} from '@/shared/parameter-schemas/hcs.zod';

import { Client, Hbar, PublicKey, TokenSupplyType, TokenType } from '@hashgraph/sdk';
import { Context } from '@/shared/configuration';
import z from 'zod';
import {
  accountBalanceQueryParameters,
  accountTokenBalancesQueryParameters,
} from '@/shared/parameter-schemas/query.zod';
import { IHederaMirrornodeService } from '@/shared/hedera-utils/mirrornode/hedera-mirrornode-service.interface';
import { toBaseUnit } from '@/shared/hedera-utils/decimals-utils';
import Long from 'long';
import { TokenTransferMinimalParams, TransferHbarInput } from '@/shared/hedera-utils/types';
import { AccountResolver } from '@/shared/utils/account-resolver';
import { ethers } from 'ethers';
import {
  createERC20Parameters,
  transferERC20Parameters,
  transferERC721Parameters,
  mintERC721Parameters,
} from '@/shared/parameter-schemas/evm.zod';

export default class HederaParameterNormaliser {
  static async normaliseCreateFungibleTokenParams(
    params: z.infer<ReturnType<typeof createFungibleTokenParameters>>,
    context: Context,
    client: Client,
    mirrorNode: IHederaMirrornodeService,
  ) {
    const defaultAccountId = AccountResolver.getDefaultAccount(context, client);

    const normalized: z.infer<ReturnType<typeof createFungibleTokenParametersNormalised>> = {
      ...params,
      supplyType: TokenSupplyType.Finite, // defaults to finite supply
      autoRenewAccountId: defaultAccountId,
    };

    const treasuryAccountId = params.treasuryAccountId ?? defaultAccountId;

    if (!treasuryAccountId) {
      throw new Error('Must include treasury account ID');
    }

    const supplyTypeString = params.supplyType ?? 'infinite';
    const supplyType =
      supplyTypeString === 'finite' ? TokenSupplyType.Finite : TokenSupplyType.Infinite;
    const decimals = params.decimals ?? 0;
    const initialSupply = toBaseUnit(params.initialSupply ?? 0, decimals);

    let maxSupply: number | undefined = undefined;
    if (supplyTypeString === 'finite') {
      if (!params.maxSupply) {
        throw new Error('Must include max supply for finite supply type');
      }
      maxSupply = toBaseUnit(params.maxSupply, decimals);

      if (initialSupply > maxSupply) {
        throw new Error(
          `Initial supply (${initialSupply}) cannot exceed max supply (${maxSupply})`,
        );
      }
    }

    const publicKey =
      (await mirrorNode.getAccount(defaultAccountId).then(r => r.accountPublicKey)) ??
      client.operatorPublicKey?.toStringDer();

    if (params.isSupplyKey === true) {
      normalized.supplyKey = PublicKey.fromString(publicKey);
    }

    const autoRenewAccountId = defaultAccountId;

    return {
      ...normalized,
      treasuryAccountId,
      supplyType,
      maxSupply,
      decimals,
      initialSupply,
      autoRenewAccountId,
    };
  }

  static async normaliseCreateNonFungibleTokenParams(
    params: z.infer<ReturnType<typeof createNonFungibleTokenParameters>>,
    context: Context,
    client: Client,
    mirrorNode: IHederaMirrornodeService,
  ) {
    const defaultAccountId = AccountResolver.getDefaultAccount(context, client);

    const treasuryAccountId = params.treasuryAccountId || defaultAccountId;
    if (!treasuryAccountId) throw new Error('Must include treasury account ID');

    const publicKey =
      (await mirrorNode.getAccount(defaultAccountId).then(r => r.accountPublicKey)) ??
      client.operatorPublicKey?.toStringDer();

    const maxSupply = params.maxSupply ?? 100;
    const normalized: z.infer<ReturnType<typeof createNonFungibleTokenParametersNormalised>> = {
      ...params,
      treasuryAccountId,
      maxSupply,
      supplyKey: PublicKey.fromString(publicKey), // the supply key is mandatory in the case of NFT
      supplyType: TokenSupplyType.Finite, // NFTs supply must be finite
      autoRenewAccountId: defaultAccountId,
      tokenType: TokenType.NonFungibleUnique,
    };

    return normalized;
  }

  static normaliseTransferHbar(
    params: z.infer<ReturnType<typeof transferHbarParameters>>,
    context: Context,
    client: Client,
  ) {
    const sourceAccountId = AccountResolver.resolveAccount(params.sourceAccountId, context, client);

    const hbarTransfers: TransferHbarInput[] = [];

    let totalTinybars = Long.ZERO;

    for (const transfer of params.transfers) {
      const amount = new Hbar(transfer.amount);

      if (amount.isNegative() || amount.toTinybars().equals(Long.ZERO)) {
        throw new Error(`Invalid transfer amount: ${transfer.amount}`);
      }

      totalTinybars = totalTinybars.add(amount.toTinybars());

      hbarTransfers.push({
        accountId: transfer.accountId,
        amount,
      });
    }

    hbarTransfers.push({
      accountId: sourceAccountId,
      amount: Hbar.fromTinybars(totalTinybars.negate()),
    });

    return {
      hbarTransfers,
      transactionMemo: params.transactionMemo,
    };
  }

  static async normaliseAirdropFungibleTokenParams(
    params: z.infer<ReturnType<typeof airdropFungibleTokenParameters>>,
    context: Context,
    client: Client,
    mirrorNode: IHederaMirrornodeService,
  ) {
    const sourceAccountId = AccountResolver.resolveAccount(params.sourceAccountId, context, client);

    const tokenInfo = await mirrorNode.getTokenInfo(params.tokenId);
    const tokenDecimals = parseInt(tokenInfo.decimals, 10);

    const tokenTransfers: TokenTransferMinimalParams[] = [];
    let totalAmount = Long.ZERO;

    for (const recipient of params.recipients) {
      const amountRaw = Number(recipient.amount);

      if (amountRaw <= 0) {
        throw new Error(`Invalid recipient amount: ${recipient.amount}`);
      }

      const amount = Long.fromString(toBaseUnit(amountRaw, tokenDecimals).toString());

      totalAmount = totalAmount.add(amount);

      tokenTransfers.push({
        tokenId: params.tokenId,
        accountId: recipient.accountId,
        amount,
      });
    }

    // Sender negative total
    tokenTransfers.push({
      tokenId: params.tokenId,
      accountId: sourceAccountId,
      amount: totalAmount.negate(),
    });

    return {
      tokenTransfers,
    };
  }

  static async normaliseCreateTopicParams(
    params: z.infer<ReturnType<typeof createTopicParameters>>,
    context: Context,
    client: Client,
    mirrorNode: IHederaMirrornodeService,
  ) {
    const defaultAccountId = AccountResolver.getDefaultAccount(context, client);
    const normalised: z.infer<ReturnType<typeof createTopicParametersNormalised>> = {
      ...params,
      autoRenewAccountId: defaultAccountId,
    };

    if (params.isSubmitKey) {
      const publicKey =
        (await mirrorNode.getAccount(defaultAccountId).then(r => r.accountPublicKey)) ??
        client.operatorPublicKey?.toStringDer();
      if (!publicKey) {
        throw new Error('Could not determine default account ID for submit key');
      }
      normalised.submitKey = PublicKey.fromString(publicKey);
    }

    return normalised;
  }

  static normaliseHbarBalanceParams(
    params: z.infer<ReturnType<typeof accountBalanceQueryParameters>>,
    context: Context,
    client: Client,
  ) {
    const accountId = AccountResolver.resolveAccount(params.accountId, context, client);
    return {
      ...params,
      accountId,
    };
  }

  static normaliseAccountTokenBalancesParams(
    params: z.infer<ReturnType<typeof accountTokenBalancesQueryParameters>>,
    context: Context,
    client: Client,
  ) {
    const accountId = AccountResolver.resolveAccount(params.accountId, context, client);
    return {
      ...params,
      accountId,
    };
  }

  static normaliseCreateERC20Params(
    params: z.infer<ReturnType<typeof createERC20Parameters>>,
    factoryContractId: string,
    factoryContractAbi: string[],
    factoryContractFunctionName: string,
  ) {
    // Create interface for encoding
    const iface = new ethers.Interface(factoryContractAbi);

    // Encode the function call
    const encodedData = iface.encodeFunctionData(factoryContractFunctionName, [
      params.tokenName,
      params.tokenSymbol,
      params.decimals,
      params.initialSupply,
    ]);

    const functionParameters = ethers.getBytes(encodedData);

    return {
      ...params,
      contractId: factoryContractId,
      functionParameters,
      gas: 3000000, //TODO: make this configurable
    };
  }

  static normaliseCreateERC721Params(
    params: z.infer<ReturnType<typeof createERC721Parameters>>,
    factoryContractId: string,
    factoryContractAbi: string[],
    factoryContractFunctionName: string,
  ) {
    // Create interface for encoding
    const iface = new ethers.Interface(factoryContractAbi);

    // Encode the function call
    const encodedData = iface.encodeFunctionData(factoryContractFunctionName, [
      params.tokenName,
      params.tokenSymbol,
      params.baseURI,
    ]);

    const functionParameters = ethers.getBytes(encodedData);

    return {
      ...params,
      contractId: factoryContractId,
      functionParameters,
      gas: 3000000, //TODO: make this configurable
    };
  }

  static async normaliseMintFungibleTokenParams(
    params: z.infer<ReturnType<typeof mintFungibleTokenParameters>>,
    _context: Context,
    mirrorNode: IHederaMirrornodeService,
  ) {
    const decimals =
      (await mirrorNode.getTokenInfo(params.tokenId).then(r => Number(r.decimals))) ?? 0;
    const baseAmount = toBaseUnit(params.amount, decimals);
    return {
      tokenId: params.tokenId,
      amount: baseAmount,
    };
  }

  static normaliseMintNonFungibleTokenParams(
    params: z.infer<ReturnType<typeof mintNonFungibleTokenParameters>>,
    _context: Context,
  ) {
    const encoder = new TextEncoder();
    const metadata = params.uris.map(uri => encoder.encode(uri));
    return {
      ...params,
      metadata: metadata,
    };
  }

  static async normaliseTransferERC20Params(
    params: z.infer<ReturnType<typeof transferERC20Parameters>>,
    factoryContractAbi: string[],
    factoryContractFunctionName: string,
    _context: Context,
    mirrorNode: IHederaMirrornodeService,
  ) {
    const recipientAddress = await HederaParameterNormaliser.getHederaEVMAddress(
      params.recipientAddress,
      mirrorNode,
    );
    const contractId = await HederaParameterNormaliser.getHederaAccountId(
      params.contractId,
      mirrorNode,
    );
    const iface = new ethers.Interface(factoryContractAbi);
    const encodedData = iface.encodeFunctionData(factoryContractFunctionName, [
      recipientAddress,
      params.amount,
    ]);

    const functionParameters = ethers.getBytes(encodedData);

    return {
      contractId,
      functionParameters,
      gas: 100_000,
    };
  }

  static async normaliseTransferERC721Params(
    params: z.infer<ReturnType<typeof transferERC721Parameters>>,
    factoryContractAbi: string[],
    factoryContractFunctionName: string,
    _context: Context,
    mirrorNode: IHederaMirrornodeService,
  ) {
    const fromAddress = await HederaParameterNormaliser.getHederaEVMAddress(
      params.fromAddress,
      mirrorNode,
    );
    const toAddress = await HederaParameterNormaliser.getHederaEVMAddress(
      params.toAddress,
      mirrorNode,
    );
    const contractId = await HederaParameterNormaliser.getHederaAccountId(
      params.contractId,
      mirrorNode,
    );
    const iface = new ethers.Interface(factoryContractAbi);
    const encodedData = iface.encodeFunctionData(factoryContractFunctionName, [
      fromAddress,
      toAddress,
      params.tokenId,
    ]);

    const functionParameters = ethers.getBytes(encodedData);

    return {
      contractId,
      functionParameters,
      gas: 100_000,
    };
  }

  static async normaliseMintERC721Params(
    params: z.infer<ReturnType<typeof mintERC721Parameters>>,
    factoryContractAbi: string[],
    factoryContractFunctionName: string,
    _context: Context,
    mirrorNode: IHederaMirrornodeService,
  ) {
    const toAddress = await HederaParameterNormaliser.getHederaEVMAddress(
      params.toAddress,
      mirrorNode,
    );
    const contractId = await HederaParameterNormaliser.getHederaAccountId(
      params.contractId,
      mirrorNode,
    );
    const iface = new ethers.Interface(factoryContractAbi);
    const encodedData = iface.encodeFunctionData(factoryContractFunctionName, [toAddress]);
    const functionParameters = ethers.getBytes(encodedData);

    return {
      contractId,
      functionParameters,
      gas: 100_000,
    };
  }

  static async getHederaEVMAddress(
    address: string,
    mirrorNode: IHederaMirrornodeService,
  ): Promise<string> {
    if (!AccountResolver.isHederaAddress(address)) {
      return address;
    }
    const account = await mirrorNode.getAccount(address);
    return account.evmAddress;
  }

  static async getHederaAccountId(
    address: string,
    mirrorNode: IHederaMirrornodeService,
  ): Promise<string> {
    if (AccountResolver.isHederaAddress(address)) {
      return address;
    }
    const account = await mirrorNode.getAccount(address);
    return account.accountId;
  }
}
