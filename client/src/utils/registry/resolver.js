import BN from 'bn.js'
import { Buffer } from 'buffer'
import { registerMethod } from 'did-resolver'
// import HttpProvider from 'ethjs-provider-http'
import EthContract from 'ethjs-contract'
import abi from 'ethjs-abi'
import DidRegistryContract from 'ethr-did-resolver/contracts/ethr-did-registry.json'

import { ethInstance } from '../connect'
import { REGISTRY } from '.'

export function bytes32toString (bytes32) {
  return Buffer.from(bytes32.slice(2), 'hex').toString('utf8').replace(/\0+$/, '')
}

export function stringToBytes32 (str) {
  const buffstr = '0x' + Buffer.from(str).slice(0, 32).toString('hex')
  return buffstr + '0'.repeat(66 - buffstr.length)
}

export const delegateTypes = {
  Secp256k1SignatureAuthentication2018: stringToBytes32('sigAuth'),
  Secp256k1VerificationKey2018: stringToBytes32('veriKey')
}

export const attrTypes = {
  sigAuth: 'SignatureAuthentication2018',
  veriKey: 'VerificationKey2018'
}

export function wrapDidDocument (did, owner, history) {
  const now = new BN(Math.floor(new Date().getTime() / 1000))
  // const expired = {}
  const publicKey = [{
    id: `${did}#owner`,
    type: 'Secp256k1VerificationKey2018',
    owner: `did:ethr:${owner}`,
    ethereumAddress: owner 
  }]

  const authentication = [{
    type: 'Secp256k1SignatureAuthentication2018',
    publicKey: `${did}#owner`
  }]

  let delegateCount = 0
  const auth = {}
  const pks = {}
  const services = {}
  for (let event of history) {
    let validTo = event.validTo
    const key = `${event._eventName}-${event.delegateType || event.name}-${event.delegate || event.value}`
    if (validTo && validTo.gte(now)) {
      if (event._eventName === 'DIDDelegateChanged') {
        const delegateType = bytes32toString(event.delegateType)
        delegateCount++
        switch (delegateType) {
          case 'sigAuth':
            auth[key] = {
              type: 'Secp256k1SignatureAuthentication2018',
              publicKey: `${did}#delegate-${delegateCount}`
            }
          case 'veriKey':
            pks[key] = {
              id: `${did}#delegate-${delegateCount}`,
              type: 'Secp256k1VerificationKey2018',
              owner: `did:ethr:${owner}`,
              ethereumAddress: event.delegate
            }
            break
          default: {
            throw new Error(`delegateType '${delegateType}' is not defined`)
          }
        }
      } else if (event._eventName === 'DIDAttributeChanged') {
        const name = bytes32toString(event.name)
        const match = name.match(/^did\/(pub|auth|svc)\/(\w+)(\/(\w+))?(\/(\w+))?(\/(\w+))?$/)
        if (match) {
          const section = match[1]
          const algo = match[2]
          const type = attrTypes[match[4]] || match[4]
          const encoding = match[6]
          const xxx = match[8]

          switch (section) {
            case 'pub':
              delegateCount++
              const pk = {
                id: `${did}#delegate-${delegateCount}`,
                type: `${algo}${type}`,
                owner: did
              }
              switch (encoding) {
                case null:
                case undefined:
                case 'hex':
                  pk.publicKeyHex = event.value.slice(2)
                  break
                case 'base64':
                  pk.publicKeyBase64 = Buffer.from(event.value.slice(2), 'hex').toString('base64')
                  break
                case 'base58':
                  pk.publicKeyBase58 = Buffer.from(event.value.slice(2), 'hex').toString('base58')
                  break
                default:
                  pk.value = event.value
              }
              pks[key] = pk
              break
            case 'svc':
              services[key] = {type: algo, serviceEndpoint: Buffer.from(event.value.slice(2), 'hex').toString()}
              break
            case 'auth':
              const authPK = `did:ethr:${event.value}#${xxx}`
              const existingPK = Object.keys(pks).find(key => pks[key].id === authPK)
              if (existingPK) {
                const authItem = {
                  type: algo,
                  publicKey: authPK
                }
                auth[key] = authItem
              }
              break
            default: {
              throw new Error(`DID document section '${section}' is not defined`)
            }
          }
        }
      }
    } else {
      if (delegateCount > 0 && (event._eventName === 'DIDDelegateChanged' || (event._eventName === 'DIDAttributeChanged' && bytes32toString(event.delegateType).match(/^did\/publicKey\//))) && validTo.lt(now)) delegateCount--
      delete auth[key]
      delete pks[key]
      delete services[key]
    }
  }

  const doc = {
    '@context': 'https://w3id.org/did/v1',
    id: did,
    publicKey: publicKey.concat(Object.values(pks)),
    authentication: authentication.concat(Object.values(auth))
  }
  if (Object.values(services).length > 0) {
    doc.service = Object.values(services)
  }

  return doc
}

/*
function configureProvider (conf = {}) {
  if (conf.provider) {
    return conf.provider
  } else if (conf.web3) {
    return conf.web3.currentProvider
  } else {
    return new HttpProvider(conf.rpcUrl || 'https://mainnet.infura.io/ethr-did')
  }
}
*/

function register (conf = {}) {
  // const provider = configureProvider(conf)
  const registryAddress = conf.registry || REGISTRY
  const DidReg = new EthContract(ethInstance)(DidRegistryContract)
  const didReg = DidReg.at(registryAddress)
  const logDecoder = abi.logDecoder(DidRegistryContract, false)

  const lastChanged = async (identity) => {
    const result = await didReg.changed(identity)
    if (result) {
      return result['0']
    }
  }
  async function changeLog (identity) {
    const history = []
    let previousChange = await lastChanged(identity)
    while (previousChange) {
      const logs = await ethInstance.getLogs({address: registryAddress, topics: [null, `0x000000000000000000000000${identity.slice(2)}`], fromBlock: previousChange, toBlock: previousChange})
      const events = logDecoder(logs)
      previousChange = undefined
      for (let event of events) {
        history.unshift(event)
        previousChange = event.previousChange
      }
    }
    return history
  }
  async function resolve (did, parsed) {
    if (!parsed.id.match(/^0x[0-9a-fA-F]{40}$/)) throw new Error(`Not a valid ethr DID: ${did}`)
    const owner = await didReg.identityOwner(parsed.id)
    const history = await changeLog(parsed.id)
    return wrapDidDocument(did, owner['0'], history)
  }
  registerMethod('ethr', resolve)
}

export default register
// module.exports = register
