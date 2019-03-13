import bitcoin from 'bitcoinjs-lib'

import { MultipartX } from '../../modules'
import { OIPRecord } from '../../modules/records'
import { ExplorerWallet, RPCWallet } from '../../modules/wallets'
import { floMainnet, floTestnet } from '../../config'

// The maximum floData that fits in one transaction
export const FLODATA_MAX_LEN = 1040

/**
 * Class to publish, register, edit, transfer, and deactivate OIP Records
 */
class OIP {
  /**
   * ##### Example
   * ```javascript
   * import {OIP} from 'js-oip'
   *
   * let wif = "cRVa9rNx5N1YKBw8PhavegJPFCiYCfC4n8cYmdc3X1Y6TyFZGG4B"
   * let oip = new OIP(wif, "testnet")
   * ```
   * @param {String} wif - private key in Wallet Import Format (WIF) see: {@link https://en.bitcoin.it/wiki/Wallet_import_format}
   * @param {String} [network="mainnet"] - Use "testnet" for mainnet
   * @param {Object} [options] - Options to for the OIP class
   * @param {Object} [options.publicAddress] - Explicitly define a public address for the passed WIF
   * @param {Object} [options.rpc] - By default, OIP uses a connection to a web explorer to publish Records, you can however use a connection to an RPC wallet instead by passing an object into this option
   * @param {Object} [options.rpc.host] - The Hostname for the RPC wallet connection
   * @param {Object} [options.rpc.port] - The Port for the RPC wallet connection
   * @param {Object} [options.rpc.username] - The Username for the RPC wallet connection
   * @param {Object} [options.rpc.password] - The Password for the RPC wallet connection
   */
  constructor (wif, network, options) {
    this.options = options || {}

    this.options.wif = wif
    this.options.network = network

    // If public address is not defined, calculate it using bitcoin-js (used by RPC-Wallet)
    if (!this.options.publicAddress) {
      let tmpNetwork = floMainnet
      if (network === 'testnet') { tmpNetwork = floTestnet }

      let ECPair = bitcoin.ECPair.fromWIF(this.options.wif, tmpNetwork.network)
      this.options.publicAddress = bitcoin.payments.p2pkh({ pubkey: ECPair.publicKey, network: tmpNetwork.network }).address
    }

    if (this.options.rpc) {
      this.wallet = new RPCWallet(this.options)
      this.walletInitialized = false
    } else {
      this.wallet = new ExplorerWallet(this.options)
      this.walletInitialized = true
    }
  }

  async signRecord (record) {
    if (!record.getSignature() || record.getSignature() === '') {
      record.setPubAddress(this.options.publicAddress)
      let { success, error } = await record.signSelf(this.wallet.signMessage.bind(this.wallet))
      if (!success) {
        console.log(error.stack)
        throw new Error(`Failed to sign record: ${error}`)
      }
      if (!record.hasValidSignature()) {
        throw new Error(`Invalid signature`)
      }
    }
  }

  async broadcastRecord (record, methodType) {
    if (!(record instanceof OIPRecord)) {
      throw new Error(`Record must be an instanceof OIPRecord`)
    }

    // Make sure the wallet has had time to initialize
    if (!this.walletInitialized) {
      await this.wallet.initialize()
      this.walletInitialized = true
    }

    try {
      await this.signRecord(record)
    } catch (error) {
      return { success: false, error: `Error while Signing Record: ${error}` }
    }

    let { success, error } = record.isValid()

    if (!success) {
      return { success: false, error: `Invalid record: ${error}` }
    }

    let broadcastString = record.serialize(methodType)
    let txids

    if (broadcastString.length > FLODATA_MAX_LEN) {
      try {
        txids = await this.publishMultiparts(broadcastString)
      } catch (err) {
        return { success: false, error: `Failed to publish multiparts: ${err}` }
      }
    } else {
      try {
        let txid = await this.wallet.sendDataToChain(broadcastString)
        txids = [txid]
      } catch (err) {
        return { success: false, error: `Failed to broadcast message: ${err}` }
      }
    }

    // Set the txid to the Record
    record.setTXID(txids[0])

    let response = { success: true, txids, record }

    return response
  }

  /**
   * Publish OIP Records
   * @param {OIPRecord} record - an Artifact, Publisher, Platform, Retailer, or Influencer
   * @return {Promise<string|Array<string>>} txid - a txid or an array of txids (if your record is too large to fit onto one tx)
   * let oip = new OIP(wif, "testnet")
   * let artifact = new Artifact()
   * let result = await oip.publish(artifact)
   */
  async publish (record) {
    let res = await this.broadcastRecord(record, 'publish')

    return res
  }

  // async register(record) {
  // } //ToDo

  /**
   * Publish an Edit for a Record
   * @param  {OIPRecord} editedRecord - The new version of the Record
   * @return {Promise<string|Array<string>>} txid - a txid or an array of txids (if your edit is too large to fit onto one tx)
   */
  async edit (editedRecord) {
    // Lookup the currently latest version of the Record
    // Throw an Error if record does not exist

    // Create an Edit Record from the Original and Edited
    // Throw an error if there is no edit patch (aka, they are the same)

    // Publish to chain
  }

  // async transfer(record) {
  // } //ToDO
  // async deactivate(record) {
  // } //ToDo

  /**
   * Publish data that exceeds the maximum floData length in multiple parts
   * @param {string} data - The data you wish to publish
   * @return {Promise<Array.<String>>} txids - An array of transaction IDs
   * @example
   * let oip = new OIP(wif, "testnet")
   * let txArray = await oip.publishMultiparts(superLongStringData)
   * //For multipart publishing, use oip.publish() instead. Will auto redirect to this function
   */
  async publishMultiparts (data) {
    if (typeof data !== 'string') {
      throw new Error(`Data must be of type string. Got: ${typeof data}`)
    }

    // Make sure the wallet has had time to initialize
    if (!this.walletInitialized) {
      await this.wallet.initialize()
      this.walletInitialized = true
    }

    let mpx = new MultipartX(data)
    let mps = mpx.getMultiparts()

    let txids = []

    for (let mp of mps) {
      // set reference, addr, and sign
      mp.setAddress(this.options.publicAddress)
      if (txids.length > 0) {
        mp.setReference(txids[0])
      }
      let { error } = await mp.signSelf(this.wallet.signMessage.bind(this.wallet))
      if (error) {
        throw new Error(`Failed to sign multipart: ${error}`)
      }

      // not going to be valid yet or will it
      if (!mp.isValid().success) {
        console.log(mp)
        throw new Error(`Invalid multipart: ${mp.isValid().error}`)
      }

      let txid
      try {
        // console.log(mp.toString())
        // console.log(mp.toString().length)
        // throw new Error('STOP')
        txid = await this.wallet.sendDataToChain(mp.toString())
      } catch (err) {
        console.log(err.stack)
        throw new Error(`Failed to broadcast multipart: ${err}`)
      }
      // console.log(txid)
      txids.push(txid)
    }
    return txids
  }
}

export default OIP
