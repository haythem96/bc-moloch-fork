/* global artifacts, contract, assert, web3 */
/* eslint-env mocha */

// TODO
// - events

const Moloch = artifacts.require('./Moloch')
const CurvedGuildBank = artifacts.require('./CurvedGuildBank')

const utils = require('./utils')
const safeUtils = require('./utilsPersonalSafe')

const config = process.env.target != 'mainnet' ? require('../migrations/config.json').test : require('../migrations/config.json').mainnet

console.log("environment: ", process.env.target)
console.log(config)

const abi = require('web3-eth-abi')

const HttpProvider = require(`ethjs-provider-http`)
const EthRPC = require(`ethjs-rpc`)
const ethRPC = new EthRPC(new HttpProvider('http://localhost:7545'))

const BigNumber = web3.BigNumber
const BN = web3.utils.BN

const should = require('chai').use(require('chai-as-promised')).use(require('chai-bignumber')(BigNumber)).should()

const SolRevert = 'VM Exception while processing transaction: revert'

const zeroAddress = '0x0000000000000000000000000000000000000000'
const _1e18 = new BN('1000000000000000000') // 1e18

async function blockTime() {
  const block = await web3.eth.getBlock('latest')
  return block.timestamp
}

function getEventParams(tx, event) {
  if (tx.logs.length > 0) {
    for (let idx=0; idx < tx.logs.length; idx++) {
      if (tx.logs[idx].event == event) {
        return tx.logs[idx].args
      }
    }
  }
  return false
}

async function snapshot() {
  return new Promise((accept, reject) => {
    ethRPC.sendAsync({method: `evm_snapshot`}, (err, result)=> {
      if (err) {
        reject(err)
      } else {
        accept(result)
      }
    })
  })
}

async function restore(snapshotId) {
  return new Promise((accept, reject) => {
    ethRPC.sendAsync({method: `evm_revert`, params: [snapshotId]}, (err, result) => {
      if (err) {
        reject(err)
      } else {
        accept(result)
      }
    })
  })
}

async function forceMine() {
  return await ethRPC.sendAsync({method: `evm_mine`}, (err)=> {});
}

async function moveForwardPeriods(periods) {
  const blocktimestamp = await blockTime()
  const goToTime = config.PERIOD_DURATION_IN_SECONDS * periods
  await ethRPC.sendAsync({
    jsonrpc:'2.0', method: `evm_increaseTime`,
    params: [goToTime],
    id: 0
  }, (err)=> {`error increasing time`});
  await forceMine()
  const updatedBlocktimestamp = await blockTime()
  return true
}

let moloch, curvedGuildBank
let lw, executor
let investorProposal, artistProposal, proposal2

const initSummonerBalance = 100

const msgValue = web3.utils.toWei('20', 'ether')

contract('Moloch fork', accounts => {
  let snapshotId

  // VERIFY SUBMIT PROPOSAL
  const verifySubmitProposal = async (proposal, proposalIndex, options) => {
    const initialTotalSharesRequested = options.initialTotalSharesRequested ? options.initialTotalSharesRequested : 0
    const initialTotalShares = options.initialTotalShares ? options.initialTotalShares : 0
    const initialProposalLength = options.initialProposalLength ? options.initialProposalLength : 0
    const initialMolochTokenBalance = options.initialMolochTokenBalance ? options.initialMolochTokenBalance : 0
    const initialMolochBalance = options.initialMolochBalance ? options.initialMolochBalance : 0

    const expectedStartingPeriod = options.expectedStartingPeriod ? options.expectedStartingPeriod : 1

    const ethValue = options.ethValue ? options.ethValue : 0
    //const tributeTokenPrice = options.tributeTokenPrice ? options.tributeTokenPrice : 0

    const proposalData = await moloch.proposalQueue.call(proposalIndex)
    assert.equal(proposalData.applicant, proposal.applicant)
    if (typeof proposal.sharesRequested == 'number') {
      assert.equal(proposalData.sharesRequested, proposal.sharesRequested)
    } else { // for testing overflow boundary with BNs
      assert(proposalData.sharesRequested.eq(proposal.sharesRequested))
    }
    assert.equal(proposalData.startingPeriod, expectedStartingPeriod)
    assert.equal(proposalData.yesVotes, 0)
    assert.equal(proposalData.noVotes, 0)
    assert.equal(proposalData.processed, false)
    assert.equal(proposalData.didPass, false)
    assert.equal(proposalData.aborted, false)
    assert.equal(proposalData.details, proposal.details)
    assert.equal(proposalData.maxTotalSharesAtYesVote, 0)

    
    if(ethValue > 0) {
      assert.equal(proposalData.depositedETH, true)      
    }
    else {
      assert.equal(proposalData.depositedETH, false)
    }

    const totalSharesRequested = await moloch.totalSharesRequested()
    if (typeof proposal.sharesRequested == 'number') {
      assert.equal(totalSharesRequested, proposal.sharesRequested + initialTotalSharesRequested)
    } else { // for testing overflow boundary with BNs
      assert(totalSharesRequested.eq(proposal.sharesRequested.add(new BN(initialTotalSharesRequested))))
    }

    const totalShares = await moloch.totalShares()
    assert.equal(totalShares, initialTotalShares)

    const proposalQueueLength = await moloch.getProposalQueueLength()
    assert.equal(proposalQueueLength, initialProposalLength + 1)

    const molochTokenBalance = await curvedGuildBank.balanceOf(moloch.address)
    assert.equal(molochTokenBalance.toNumber(), initialMolochTokenBalance) 

    const molochBalace = await web3.eth.getBalance(moloch.address)
    assert.equal(molochBalace, parseInt(initialMolochBalance) + parseInt(tributeTokenPrice));

    //TODO: check msg.sender ETH balance
  }

  // VERIFY SUBMIT VOTE
  const verifySubmitVote = async (proposal, proposalIndex, memberAddress, expectedVote, options) => {
    const initialYesVotes = options.initialYesVotes ? options.initialYesVotes : 0
    const initialNoVotes = options.initialNoVotes ? options.initialNoVotes : 0
    const expectedMaxSharesAtYesVote = options.expectedMaxSharesAtYesVote ? options.expectedMaxSharesAtYesVote : 0

    const proposalData = await moloch.proposalQueue.call(proposalIndex)
    assert.equal(proposalData.yesVotes, initialYesVotes + (expectedVote == 1 ? 1 : 0))
    assert.equal(proposalData.noVotes, initialNoVotes + (expectedVote == 1 ? 0 : 1))
    assert.equal(proposalData.maxTotalSharesAtYesVote, expectedMaxSharesAtYesVote)

    const memberVote = await moloch.getMemberProposalVote(memberAddress, proposalIndex)
    assert.equal(memberVote, expectedVote)
  }

  // VERIFY PROCESS PROPOSAL - note: doesnt check forced reset of delegate key
  const verifyProcessProposal = async (proposal, proposalIndex, proposer, processor, options) => {
    const initialTotalSharesRequested = options.initialTotalSharesRequested ? options.initialTotalSharesRequested : 0
    const initialTotalShares = options.initialTotalShares ? options.initialTotalShares : 0
    const initialApplicantShares = options.initialApplicantShares ? options.initialApplicantShares : 0 // 0 means new member, > 0 means existing member
    const initialMolochBalance = options.initialMolochBalance ? options.initialMolochBalance : 0
    console.log("initial moloch balance: ", initialMolochBalance);
    const initialGuildBankBalance = options.initialGuildBankBalance ? options.initialGuildBankBalance : 0
    const initialApplicantBalance = options.initialApplicantBalance ? options.initialApplicantBalance : 0
    const initialProcessorBalance = options.initialProcessorBalance ? options.initialProcessorBalance : 0
    const expectedYesVotes = options.expectedYesVotes ? options.expectedYesVotes : 0
    const expectedNoVotes = options.expectedNoVotes ? options.expectedNoVotes : 0
    const expectedMaxSharesAtYesVote = options.expectedMaxSharesAtYesVote ? options.expectedMaxSharesAtYesVote : 0
    const expectedFinalTotalSharesRequested = options.expectedFinalTotalSharesRequested ? options.expectedFinalTotalSharesRequested : 0
    const didPass = typeof options.didPass == 'boolean' ? options.didPass : true
    const aborted = typeof options.aborted == 'boolean' ? options.aborted : false
    const initialMolochTokenBalance = options.initialMolochTokenBalance ? options.initialMolochTokenBalance : 0

    const proposalData = await moloch.proposalQueue.call(proposalIndex)
    assert.equal(proposalData.yesVotes, expectedYesVotes)
    assert.equal(proposalData.noVotes, expectedNoVotes)
    assert.equal(proposalData.maxTotalSharesAtYesVote, expectedMaxSharesAtYesVote)
    assert.equal(proposalData.processed, true)
    assert.equal(proposalData.didPass, didPass)
    assert.equal(proposalData.aborted, aborted)

    const totalSharesRequested = await moloch.totalSharesRequested()
    assert.equal(totalSharesRequested, expectedFinalTotalSharesRequested)

    const totalShares = await moloch.totalShares()
    assert.equal(totalShares, didPass && !aborted ? initialTotalShares + proposal.sharesRequested : initialTotalShares)

    const molochTokenBalance = await curvedGuildBank.balanceOf(moloch.address)
    console.log("moloch token balance: ", molochTokenBalance.toNumber());
    assert.equal(molochTokenBalance.toNumber(), didPass && !aborted ? initialMolochTokenBalance + proposal.tokenTribute : initialMolochTokenBalance) 

    const molochBalace = await web3.eth.getBalance(moloch.address)
    console.log("moloch balance: ", molochBalace);
    assert.equal(molochBalace, parseInt(initialMolochBalance) - parseInt(proposalData.value));
    
    const curvedGuildBankBalance = await web3.eth.getBalance(curvedGuildBank.address)
    console.log("curved guild bank balance: ", curvedGuildBankBalance);

    if (didPass && !aborted) {
      // existing member
      if (initialApplicantShares > 0) {
        const memberData = await moloch.members(proposal.applicant)
        assert.equal(memberData.shares, proposal.sharesRequested + initialApplicantShares)
        console.log("existing member shares: ", parseInt(memberData.shares))

      // new member
      } else {
        const newMemberData = await moloch.members(proposal.applicant)
        assert.equal(newMemberData.delegateKey, proposal.applicant)
        assert.equal(newMemberData.shares, proposal.sharesRequested)
        assert.equal(newMemberData.exists, true)
        assert.equal(newMemberData.highestIndexYesVote, 0)

        const newMemberAddressByDelegateKey = await moloch.memberAddressByDelegateKey(proposal.applicant)
        assert.equal(newMemberAddressByDelegateKey, proposal.applicant)
        console.log("new member shares: ", parseInt(newMemberData.shares))
      }
    }
  }

  // VERIFY UPDATE DELEGATE KEY
  const verifyUpdateDelegateKey = async (memberAddress, oldDelegateKey, newDelegateKey) => {
    const member = await moloch.members(memberAddress)
    assert.equal(member.delegateKey, newDelegateKey)
    const memberByOldDelegateKey = await moloch.memberAddressByDelegateKey(oldDelegateKey)
    assert.equal(memberByOldDelegateKey, zeroAddress)
    const memberByNewDelegateKey = await moloch.memberAddressByDelegateKey(newDelegateKey)
    assert.equal(memberByNewDelegateKey, memberAddress)
  }

  before('deploy contracts', async () => {
    moloch = await Moloch.new(accounts[0], "Curved Moloch", "CM", 17280, 35, 35, 5, 3, 1)
    const guildBankAddress = await moloch.guildBank()
    curvedGuildBank = await CurvedGuildBank.at(guildBankAddress)
  })

  beforeEach(async () => {
    snapshotId = await snapshot()

    creator = accounts[0]
    summoner = accounts[1]

    investorProposal = {
      applicant: accounts[2],
      sharesRequested: 1,
      details: "all investors hail moloch"
    }

    artistProposal = {
      applicant: accounts[3],
      sharesRequested: 1,
      details: "all artists hail moloch"
    }

    processor = accounts[9]

  })

  afterEach(async () => {
    await restore(snapshotId)
  })

  it('verify deployment parameters', async () => {
    const now = await blockTime()

    const curvedGuildBankAddress = await moloch.guildBank()
    assert.equal(curvedGuildBankAddress, curvedGuildBank.address)
    
    const guildBankOwner = await curvedGuildBank.owner()
    assert.equal(guildBankOwner, moloch.address)
    
    const periodDuration = await moloch.periodDuration()
    assert.equal(+periodDuration, config.PERIOD_DURATION_IN_SECONDS)
    
    const votingPeriodLength = await moloch.votingPeriodLength()
    assert.equal(+votingPeriodLength, config.VOTING_DURATON_IN_PERIODS)

    const gracePeriodLength = await moloch.gracePeriodLength()
    assert.equal(+gracePeriodLength, config.GRACE_DURATON_IN_PERIODS)

    const abortWindow = await moloch.abortWindow()
    assert.equal(+abortWindow, config.ABORT_WINDOW_IN_PERIODS)

    const dilutionBound = await moloch.dilutionBound()
    assert.equal(+dilutionBound, config.DILUTION_BOUND)

    const currentPeriod = await moloch.getCurrentPeriod()
    assert.equal(+currentPeriod, 0)
    
    const summonerData = await moloch.members(creator)
    assert.equal(summonerData.delegateKey, creator) // delegateKey matches
    assert.equal(summonerData.shares, 1)
    assert.equal(summonerData.exists, true)
    assert.equal(summonerData.highestIndexYesVote, 0)

    const summonerAddressByDelegateKey = await moloch.memberAddressByDelegateKey(creator)
    assert.equal(summonerAddressByDelegateKey, creator)

    const totalShares = await moloch.totalShares()
    assert.equal(+totalShares, 1) 

    const molochTokenBalance = await curvedGuildBank.balanceOf(moloch.address)
    assert.equal(molochTokenBalance.toNumber(), 0)    
  })
  
  describe('submitProposal', () => {
    beforeEach(async () => {
    })

    describe('Investor', () => {
      it('Investor happy case', async () => { 
        const initialMolochBalance = await web3.eth.getBalance(moloch.address);   
        await moloch.submitProposal(investorProposal.sharesRequested, investorProposal.details, { from: investorProposal.applicant, value: msgValue })
        await verifySubmitProposal(investorProposal, 0, {
          initialTotalShares: 1,
          initialMolochTokenBalance: 0,
          initialMolochBalance: initialMolochBalance,
          ethValue: msgValue,
        })
      })
      
      it('require fail - insufficient deposited ETH', async () => {    
        await moloch.submitProposal(investorProposal.sharesRequested, investorProposal.details, { from: investorProposal.applicant, value: 0 }).should.be.rejectedWith('Did not send enough ether to buy tributed tokens')
      })

      describe('uint overflow boundary', () => {
        it('require fail - uint overflow', async () => {
          investorProposal.sharesRequested = _1e18
          await moloch.submitProposal(investorProposal.sharesRequested, investorProposal.details, { from: investorProposal.applicant, value: msgValue }).should.be.rejectedWith('too many shares requested')
        })
  
        it('success - request 1 less share than the overflow limit', async () => {
          const initialMolochBalance = await web3.eth.getBalance(moloch.address);   
          investorProposal.sharesRequested = _1e18.sub(new BN(1)) // 1 less
          await moloch.submitProposal(investorProposal.sharesRequested, investorProposal.details, { from: investorProposal.applicant, value: msgValue })
          await verifySubmitProposal(investorProposal, 0, {
            initialTotalShares: 1,
            initialMolochTokenBalance: 0,
            initialMolochBalance: initialMolochBalance,
            ethValue: msgValue,
          })
        })
      })
  
      it('edge case - shares requested is 0', async () => {
        const initialMolochBalance = await web3.eth.getBalance(moloch.address);   
        investorProposal.sharesRequested = 0
        await moloch.submitProposal(investorProposal.sharesRequested, investorProposal.details, { from: investorProposal.applicant, value: msgValue })
        await verifySubmitProposal(investorProposal, 0,{
          initialTotalShares: 1,
          initialMolochTokenBalance: 0,
          initialMolochBalance: initialMolochBalance,
          ethValue: msgValue,
        })
      })
    });
    
    describe('Artist', () => {
      it('Artist happy case', async () => { 
        const initialMolochBalance = await web3.eth.getBalance(moloch.address);   
        await moloch.submitProposal(artistProposal.sharesRequested, artistProposal.details, { from: artistProposal.applicant })
        await verifySubmitProposal(artistProposal, 0, {
          initialTotalShares: 1,
          initialMolochTokenBalance: 0,
          initialMolochBalance: initialMolochBalance
        })
      })

      it('success - deposit ETH', async () => {
        const initialMolochBalance = await web3.eth.getBalance(moloch.address);   
        await moloch.submitProposal(artistProposal.sharesRequested, artistProposal.details, { from: artistProposal.applicant, value: msgValue })
        await verifySubmitProposal(artistProposal, 0, {
          initialTotalShares: 1,
          initialMolochTokenBalance: 0,
          initialMolochBalance: initialMolochBalance,
          ethValue: msgValue
        })
      })
    })
    
  })
  /*
  describe('submitVote', () => {

    beforeEach(async () => {
      await moloch.submitProposal(investorProposal.tokenTribute, investorProposal.sharesRequested, investorProposal.details, { from: investorProposal.applicant, value: msgValue })
      await moloch.submitProposal(artistProposal.tokenTribute, artistProposal.sharesRequested, artistProposal.details, { from: artistProposal.applicant })
    })

    it('happy case - yes vote', async () => {
      await moveForwardPeriods(1)
      await moloch.submitVote(0, 1, { from: creator })
      await verifySubmitVote(investorProposal, 0, creator, 1, {
        expectedMaxSharesAtYesVote: 1
      })

      await moveForwardPeriods(1)
      await moloch.submitVote(1, 1, { from: creator })
      await verifySubmitVote(artistProposal, 0, creator, 1, {
        expectedMaxSharesAtYesVote: 1
      })
    })
    
    it('happy case - no vote', async () => {
      await moveForwardPeriods(1)
      await moloch.submitVote(0, 2, { from: creator })
      await verifySubmitVote(investorProposal, 0, creator, 2, {})

      await moveForwardPeriods(1)
      await moloch.submitVote(1, 2, { from: creator })
      await verifySubmitVote(artistProposal, 0, creator, 2, {})
    })

    it('require fail - proposal does not exist', async () => {
      await moveForwardPeriods(1)
      await moloch.submitVote(2, 1, { from: creator }).should.be.rejectedWith('proposal does not exist')
    })

    it('require fail - voting period has not started', async () => {
      // don't move the period forward
      await moloch.submitVote(0, 1, { from: creator }).should.be.rejectedWith('voting period has not started')
    })

    describe('voting period boundary', () => {
      it('require fail - voting period has expired', async () => {
        await moveForwardPeriods(config.VOTING_DURATON_IN_PERIODS + 1)
        await moloch.submitVote(0, 1, { from: creator }).should.be.rejectedWith('voting period has expired')
      })

      it('success - vote 1 period before voting period expires', async () => {
        await moveForwardPeriods(config.VOTING_DURATON_IN_PERIODS)
        await moloch.submitVote(0, 1, { from: creator })
        await verifySubmitVote(investorProposal, 0, creator, 1, {
          expectedMaxSharesAtYesVote: 1
        })
      })
    })

    it('require fail - member has already voted', async () => {
      await moveForwardPeriods(1)
      await moloch.submitVote(0, 1, { from: creator })
      await moloch.submitVote(0, 1, { from: creator }).should.be.rejectedWith('member has already voted on this proposal')
    })

    it('require fail - vote must be yes or no', async () => {
      await moveForwardPeriods(1)
      // vote null
      await moloch.submitVote(0, 0, { from: creator }).should.be.rejectedWith('vote must be either Yes or No')
      // vote out of bounds
      await moloch.submitVote(0, 3, { from: creator }).should.be.rejectedWith('uintVote must be less than 3')
    })

    it('require fail - proposal has been aborted', async () => {
      await moloch.abort(0, { from: investorProposal.applicant })
      await moveForwardPeriods(1)
      await moloch.submitVote(0, 1, { from: creator }).should.be.rejectedWith('proposal has been aborted')
    })

    it('modifier - delegate', async () => {
      await moveForwardPeriods(1)
      await moloch.submitVote(0, 1, { from: summoner }).should.be.rejectedWith('not a delegate')
    })
  })
  
  describe('processProposal', () => {
    beforeEach(async () => {
      await moloch.submitProposal(investorProposal.tokenTribute, investorProposal.sharesRequested, investorProposal.details, { from: investorProposal.applicant, value: msgValue })

      await moveForwardPeriods(1)
      await moloch.submitVote(0, 1, { from: creator })

      await moveForwardPeriods(config.VOTING_DURATON_IN_PERIODS)
    })

    it('happy case', async () => {
      const initialMolochBalance = await web3.eth.getBalance(moloch.address); 

      await moveForwardPeriods(config.GRACE_DURATON_IN_PERIODS)
      await moloch.processProposal(0, { from: processor })
      await verifyProcessProposal(investorProposal, 0, investorProposal.applicant, processor, {
        initialTotalSharesRequested: 1,
        initialTotalShares: 1,
        initialMolochTokenBalance: 0,
        initialMolochBalance: initialMolochBalance,
        initialProposerBalance: initSummonerBalance - config.PROPOSAL_DEPOSIT,
        expectedYesVotes: 1,
        expectedMaxSharesAtYesVote: 1
      })
    })
    
    it('require fail - proposal does not exist', async () => {
      await moveForwardPeriods(config.GRACE_DURATON_IN_PERIODS)
      await moloch.processProposal(1).should.be.rejectedWith('proposal does not exist')
    })

    it('require fail - proposal is not ready to be processed', async () => {
      await moveForwardPeriods(config.GRACE_DURATON_IN_PERIODS - 1)
      await moloch.processProposal(0).should.be.rejectedWith('proposal is not ready to be processed')
    })

    it('require fail - proposal has already been processed', async () => {
      await moveForwardPeriods(config.GRACE_DURATON_IN_PERIODS)
      await moloch.processProposal(0, { from: processor })
      await moloch.processProposal(0).should.be.rejectedWith('proposal has already been processed')
    })
    
  })
  
  describe('processProposal - edge cases', () => {
    beforeEach(async () => {
      await moloch.submitProposal(investorProposal.tokenTribute, investorProposal.sharesRequested, investorProposal.details, { from: investorProposal.applicant, value: msgValue })

      await moveForwardPeriods(config.VOTING_DURATON_IN_PERIODS)
    })

    it('proposal fails when no votes > yes votes', async () => {
      const initialMolochBalance = await web3.eth.getBalance(moloch.address); 

      await moloch.submitVote(0, 2, { from: creator })
      await moveForwardPeriods(config.VOTING_DURATON_IN_PERIODS)
      await moveForwardPeriods(config.GRACE_DURATON_IN_PERIODS)
      await moloch.processProposal(0, { from: processor })
      await verifyProcessProposal(investorProposal, 0, investorProposal.applicant, processor, {
        initialTotalSharesRequested: 1,
        initialTotalShares: 1,
        initialMolochTokenBalance: 0,
        initialMolochBalance: initialMolochBalance,
        initialProposerBalance: initSummonerBalance - config.PROPOSAL_DEPOSIT,
        expectedNoVotes: 1,
        didPass: false
      })
    })
  })
  
  describe('processProposal - more edge cases', () => {
    beforeEach(async () => {
      investorProposal.applicant = creator;
      await moloch.submitProposal(investorProposal.tokenTribute, investorProposal.sharesRequested, investorProposal.details, { from: investorProposal.applicant, value: msgValue })

      await moveForwardPeriods(1)
    })

    it('when applicant is an existing member, adds to their shares', async () => {
      const initialMolochBalance = await web3.eth.getBalance(moloch.address); 

      await moloch.submitVote(0, 1, { from: creator })

      await moveForwardPeriods(config.VOTING_DURATON_IN_PERIODS)
      await moveForwardPeriods(config.GRACE_DURATON_IN_PERIODS)
      await moloch.processProposal(0, { from: processor })
      await verifyProcessProposal(investorProposal, 0, investorProposal.applicant, processor, {
        initialTotalSharesRequested: 1,
        initialTotalShares: 1,
        initialApplicantShares: 1, // existing member with 1 share
        initialMolochTokenBalance: 0,
        initialMolochBalance: initialMolochBalance,
        expectedYesVotes: 1,
        expectedMaxSharesAtYesVote: 1
      })
    })
  })
  
  describe('processProposal + abort', () => {
    beforeEach(async () => {
      await moloch.submitProposal(investorProposal.tokenTribute, investorProposal.sharesRequested, investorProposal.details, { from: investorProposal.applicant, value: msgValue })

      await moveForwardPeriods(1)
      await moloch.submitVote(0, 1, { from: creator })
    })

    it('proposal passes when applicant does not abort', async () => {
      let initialMolochBalance = await web3.eth.getBalance(moloch.address); 

      await moveForwardPeriods(config.VOTING_DURATON_IN_PERIODS)
      await moveForwardPeriods(config.GRACE_DURATON_IN_PERIODS)
      await moloch.processProposal(0, { from: processor })
      await verifyProcessProposal(investorProposal, 0, investorProposal.applicant, processor, {
        initialTotalSharesRequested: 1,
        initialTotalShares: 1,
        initialMolochTokenBalance: 0,
        initialMolochBalance: initialMolochBalance,
        expectedYesVotes: 1,
        expectedMaxSharesAtYesVote: 1
      })
    })

    it('proposal fails when applicant aborts', async () => {
      await moloch.abort(0, { from: investorProposal.applicant })

      let initialMolochBalance = await web3.eth.getBalance(moloch.address); 

      await moveForwardPeriods(config.VOTING_DURATON_IN_PERIODS)
      await moveForwardPeriods(config.GRACE_DURATON_IN_PERIODS)
      await moloch.processProposal(0, { from: processor })
      await verifyProcessProposal(investorProposal, 0, investorProposal.applicant, processor, {
        initialTotalSharesRequested: 1,
        initialTotalShares: 1,
        initialMolochTokenBalance: 0,
        initialMolochBalance: initialMolochBalance,
        expectedYesVotes: 1,
        expectedMaxSharesAtYesVote: 1,
        didPass: false, // false because aborted
        aborted: true // proposal was aborted
      })
    })
    
  })
  
  describe('ragequit', () => {
    beforeEach(async () => {
      await moloch.submitProposal(investorProposal.tokenTribute, investorProposal.sharesRequested, investorProposal.details, { from: investorProposal.applicant, value: msgValue })

      await moveForwardPeriods(1)
      await moloch.submitVote(0, 1, { from: creator })

      await moveForwardPeriods(config.VOTING_DURATON_IN_PERIODS)
      await moveForwardPeriods(config.GRACE_DURATON_IN_PERIODS)
    })

    it('happy case', async () => {
      await moloch.processProposal(0, { from: processor })

      let molochTokenBalance = await curvedGuildBank.balanceOf(moloch.address)
      console.log("Moloch token balance before: ", molochTokenBalance.toNumber())

      let summonerTokenBalance = await curvedGuildBank.balanceOf(creator)
      console.log("Summoner token balance before: ", summonerTokenBalance.toNumber())

      console.log("Total shares: ", parseInt(await moloch.totalShares()));
      console.log("Shares to burn: ", 1);

      await moloch.ragequit(1, { from: creator })

      const totalShares = await moloch.totalShares()
      assert.equal(totalShares, investorProposal.sharesRequested)

      const summonerData = await moloch.members(creator)
      assert.equal(summonerData.shares, 0)
      assert.equal(summonerData.exists, true)
      assert.equal(summonerData.highestIndexYesVote, 0)

      molochTokenBalance = await curvedGuildBank.balanceOf(moloch.address)
      console.log("Moloch token balance after: ", molochTokenBalance.toNumber())

      summonerTokenBalance = await curvedGuildBank.balanceOf(creator)
      console.log("Summoner token balance after: ", summonerTokenBalance.toNumber())
    })
    
    it('require fail - insufficient shares', async () => {
      await moloch.processProposal(0, { from: processor })
      await moloch.ragequit(2, { from: creator }).should.be.rejectedWith('insufficient shares')
    })

    it('require fail - cant ragequit yet', async () => {
      // skip processing the proposal
      await moloch.ragequit(1, { from: creator }).should.be.rejectedWith('cant ragequit until highest index proposal member voted YES on is processed')
    })

    it('modifier - member - non-member', async () => {
      await moloch.processProposal(0, { from: processor })
      await moloch.ragequit(1, { from: summoner }).should.be.rejectedWith('not a member')
    })

    it('modifier - member - member ragequit', async () => {
      await moloch.processProposal(0)
      await moloch.ragequit(1, { from: creator })
      await moloch.ragequit(1, { from: creator }).should.be.rejectedWith('not a member')
    })
    
    // TODO how might guildbank withdrawal fail?
    // - it could uint256 overflow
  })
  
  describe('abort', () => {
    beforeEach(async () => {
      await moloch.submitProposal(investorProposal.tokenTribute, investorProposal.sharesRequested, investorProposal.details, { from: investorProposal.applicant, value: msgValue })
    })

    it('happy case', async () => {
      const initialMolochBalance = await web3.eth.getBalance(moloch.address); 
      
      let proposal = await moloch.proposalQueue.call(0)
      const initialProposalEth = proposal.value;

      await moloch.abort(0, { from: investorProposal.applicant })

      proposal = await moloch.proposalQueue.call(0)
      assert.equal(proposal.tokenTribute, 0)
      assert.equal(proposal.sharesRequested, 1)
      assert.equal(proposal.yesVotes, 0)
      assert.equal(proposal.noVotes, 0)
      assert.equal(proposal.maxTotalSharesAtYesVote, 0)
      assert.equal(proposal.processed, false)
      assert.equal(proposal.didPass, false)
      assert.equal(proposal.aborted, true)

      const totalSharesRequested = await moloch.totalSharesRequested()
      assert.equal(totalSharesRequested, 1)

      const totalShares = await moloch.totalShares()
      assert.equal(totalShares, 1)
      
      const molochBalance = await web3.eth.getBalance(moloch.address);
      assert.equal(molochBalance, initialMolochBalance-initialProposalEth)
    })
    
    it('require fail - proposal does not exist', async () => {
      await moloch.abort(1, { from: investorProposal.applicant }).should.be.rejectedWith('proposal does not exist')
    })

    it('require fail - msg.sender must be applicant', async () => {
      await moloch.abort(0, { from: summoner }).should.be.rejectedWith('msg.sender must be applicant')
    })

    it('require fail - proposal must not have already been aborted', async () => {
      await moloch.abort(0, { from: investorProposal.applicant })
      await moloch.abort(0, { from: investorProposal.applicant }).should.be.rejectedWith('proposal must not have already been aborted')
    })

    describe('abort window boundary', () => {
      it('require fail - abort window must not have passed', async () => {
        await moveForwardPeriods(config.ABORT_WINDOW_IN_PERIODS + 1)
        await moloch.abort(0, { from: investorProposal.applicant }).should.be.rejectedWith('abort window must not have passed')
      })

      it('success - abort 1 period before abort window expires', async () => {
        await moveForwardPeriods(config.ABORT_WINDOW_IN_PERIODS)
        await moloch.abort(0, { from: investorProposal.applicant })

        const proposal = await moloch.proposalQueue.call(0)
        assert.equal(proposal.tokenTribute, 0)
        assert.equal(proposal.aborted, true)
      })
    })
  })

  describe('guildbank.withdraw', () => {
    it('modifier - owner', async () => {
      await curvedGuildBank.withdraw(summoner, 1, 1).should.be.rejectedWith(SolRevert)
    })
  })
  /*
  describe('two proposals', () => {
    beforeEach(async () => {
      proposal2 = {
        applicant: accounts[3],
        tokenTribute: 200,
        sharesRequested: 2,
        details: ""
      }

      await token.transfer(proposal1.applicant, proposal1.tokenTribute, { from: creator })
      await token.approve(moloch.address, proposal1.tokenTribute, { from: proposal1.applicant })

      await token.transfer(proposal2.applicant, proposal2.tokenTribute, { from: creator })
      await token.approve(moloch.address, proposal2.tokenTribute, { from: proposal2.applicant })

      await token.approve(moloch.address, 20, { from: summoner })

      await moloch.submitProposal(proposal1.applicant, proposal1.tokenTribute, proposal1.sharesRequested, proposal1.details, { from: summoner })
    })

    it('processProposal require fail - previous proposal must be processed', async () => {
      await moloch.submitProposal(proposal2.applicant, proposal2.tokenTribute, proposal2.sharesRequested, proposal2.details, { from: summoner })
      await moveForwardPeriods(2)
      await moveForwardPeriods(config.VOTING_DURATON_IN_PERIODS)
      await moveForwardPeriods(config.GRACE_DURATON_IN_PERIODS)
      await moloch.processProposal(1).should.be.rejectedWith('previous proposal must be processed')

      // works after the first proposal is processed
      await moloch.processProposal(0)
      await moloch.processProposal(1)
      const proposalData = await moloch.proposalQueue(1)
      assert.equal(proposalData.processed, true)
    })

    it('submit proposal - starting period is correctly set with gaps in proposal queue', async () => {
      await moveForwardPeriods(4) // 0 -> 4
      await moloch.submitProposal(proposal2.applicant, proposal2.tokenTribute, proposal2.sharesRequested, proposal2.details, { from: summoner })
      const proposalData = await moloch.proposalQueue(1)
      assert.equal(proposalData.startingPeriod, 5)
    })

    it('submit proposal - starting period is correctly set when another proposal is ahead in the queue', async () => {
      await moveForwardPeriods(1) // 0 -> 1
      await moloch.submitProposal(proposal2.applicant, proposal2.tokenTribute, proposal2.sharesRequested, proposal2.details, { from: summoner })
      const proposalData = await moloch.proposalQueue(1)
      assert.equal(proposalData.startingPeriod, 2)
    })

    it('submitVote - yes - dont update highestIndexYesVote', async () => {
      await moloch.submitProposal(proposal2.applicant, proposal2.tokenTribute, proposal2.sharesRequested, proposal2.details, { from: summoner })
      await moveForwardPeriods(2)

      // vote yes on proposal 2
      await moloch.submitVote(1, 1, { from: summoner })
      const memberData1 = await moloch.members(summoner)
      assert.equal(memberData1.highestIndexYesVote, 1)
      await verifySubmitVote(proposal2, 1, summoner, 1, {
        expectedMaxSharesAtYesVote: 1
      })

      // vote yes on proposal 1
      await moloch.submitVote(0, 1, { from: summoner })
      await verifySubmitVote(proposal1, 0, summoner, 1, {
        expectedMaxSharesAtYesVote: 1
      })

      // highestIndexYesVote should stay the same
      const memberData2 = await moloch.members(summoner)
      assert.equal(memberData2.highestIndexYesVote, 1)
    })
  })

  describe('two members', () => {
    beforeEach(async () => {
      // 3 so total shares is 4 and we can test ragequit + dilution boundary
      proposal1.sharesRequested = 3

      await token.transfer(proposal1.applicant, proposal1.tokenTribute, { from: creator })
      await token.approve(moloch.address, 10, { from: summoner })
      await token.approve(moloch.address, proposal1.tokenTribute, { from: proposal1.applicant })

      await moloch.submitProposal(proposal1.applicant, proposal1.tokenTribute, proposal1.sharesRequested, proposal1.details, { from: summoner })

      await moveForwardPeriods(1)
      await moloch.submitVote(0, 1, { from: summoner })

      await moveForwardPeriods(config.VOTING_DURATON_IN_PERIODS)
      await moveForwardPeriods(config.GRACE_DURATON_IN_PERIODS)
      await moloch.processProposal(0, { from: processor })

      proposal2 = {
        applicant: accounts[3],
        tokenTribute: 200,
        sharesRequested: 2,
        details: ""
      }

      await token.transfer(proposal2.applicant, proposal2.tokenTribute, { from: creator })
      await token.approve(moloch.address, proposal2.tokenTribute, { from: proposal2.applicant })

      await token.approve(moloch.address, 10, { from: summoner })

      await moloch.submitProposal(proposal2.applicant, proposal2.tokenTribute, proposal2.sharesRequested, proposal2.details, { from: summoner })
      await moveForwardPeriods(1)
    })

    it('proposal fails when dilution bound is exceeded', async () => {
      const member1 = proposal1.applicant

      await moloch.submitVote(1, 1, { from: summoner})
      const proposalData = await moloch.proposalQueue(1)
      assert.equal(proposalData.maxTotalSharesAtYesVote, 4)

      await moloch.ragequit(3, { from: member1 })
      await moveForwardPeriods(config.VOTING_DURATON_IN_PERIODS)
      await moveForwardPeriods(config.GRACE_DURATON_IN_PERIODS)
      await moloch.processProposal(1, { from: processor })

      await verifyProcessProposal(proposal2, 1, summoner, processor, {
        initialTotalSharesRequested: 2,
        initialTotalShares: 1, // 4 -> 1
        initialMolochBalance: 210,
        initialGuildBankBalance: 25, // 100 -> 25
        initialProposerBalance: initSummonerBalance - config.PROPOSAL_DEPOSIT - config.PROCESSING_REWARD,
        initialProcessorBalance: 1,
        expectedYesVotes: 1,
        expectedMaxSharesAtYesVote: 4,
        didPass: false
      })
    })

    it('proposal passes when dilution bound is not exceeded', async () => {
      const member1 = proposal1.applicant

      await moloch.submitVote(1, 1, { from: summoner})
      const proposalData = await moloch.proposalQueue(1)
      assert.equal(proposalData.maxTotalSharesAtYesVote, 4)

      await moloch.ragequit(2, { from: member1 })
      await moveForwardPeriods(config.VOTING_DURATON_IN_PERIODS)
      await moveForwardPeriods(config.GRACE_DURATON_IN_PERIODS)
      await moloch.processProposal(1, { from: processor })

      await verifyProcessProposal(proposal2, 1, summoner, processor, {
        initialTotalSharesRequested: 2,
        initialTotalShares: 2, // 4 -> 2
        initialMolochBalance: 210,
        initialGuildBankBalance: 50, // 100 -> 50
        initialProposerBalance: initSummonerBalance - config.PROPOSAL_DEPOSIT - config.PROCESSING_REWARD,
        initialProcessorBalance: 1,
        expectedYesVotes: 1,
        expectedMaxSharesAtYesVote: 4,
        didPass: true
      })
    })
  })

  describe('Gnosis Safe Integration', () => {
    beforeEach(async () => {
      executor = creator // used to execute gnosis safe transactions

      // Create lightwallet
      lw = await utils.createLightwallet()
      // Create Gnosis Safe

      let gnosisSafeData = await gnosisSafeMasterCopy.contract.methods.setup([lw.accounts[0], lw.accounts[1], lw.accounts[2]], 2, 0, "0x").encodeABI()

      gnosisSafe = await utils.getParamFromTxEvent(
          await proxyFactory.createProxy(gnosisSafeMasterCopy.address, gnosisSafeData),
          'ProxyCreation', 'proxy', proxyFactory.address, GnosisSafe, 'create Gnosis Safe',
      )

      // Transfer Tokens to Gnosis Safe
      await token.transfer(gnosisSafe.address, 100, { from: creator })

      // Transfer ETH to Gnosis Safe (because safe pays executor for gas)
      await web3.eth.sendTransaction({
        from: creator,
        to: gnosisSafe.address,
        value: web3.utils.toWei('1', 'ether')
      })

      proposal1.applicant = gnosisSafe.address
    })

    it('sends ether', async () => {
      const initSafeBalance = await web3.eth.getBalance(gnosisSafe.address)
      assert.equal(initSafeBalance, 1000000000000000000)
      await safeUtils.executeTransaction(lw, gnosisSafe, 'executeTransaction withdraw 1 ETH', [lw.accounts[0], lw.accounts[2]], creator, web3.utils.toWei('1', 'ether'), "0x", CALL, summoner)
      const safeBalance = await web3.eth.getBalance(gnosisSafe.address)
      assert.equal(safeBalance, 0)
    })

    it('token approval', async () => {
      let data = await token.contract.methods.approve(moloch.address, 100).encodeABI()
      await safeUtils.executeTransaction(lw, gnosisSafe, 'approve token transfer to moloch', [lw.accounts[0], lw.accounts[1]], token.address, 0, data, CALL, executor)
      const approvedAmount = await token.allowance(gnosisSafe.address, moloch.address)
      assert.equal(approvedAmount, 100)
    })

    it('abort', async () => {
      // approve 100 eth from safe to moloch
      let data = await token.contract.methods.approve(moloch.address, 100).encodeABI()
      await safeUtils.executeTransaction(lw, gnosisSafe, 'approve token transfer to moloch', [lw.accounts[0], lw.accounts[1]], token.address, 0, data, CALL, executor)

      // summoner approve for proposal deposit
      await token.approve(moloch.address, 10, { from: summoner })
      // summoner submits proposal for safe
      await moloch.submitProposal(proposal1.applicant, proposal1.tokenTribute, proposal1.sharesRequested, proposal1.details, { from: summoner })

      // ABORT - gnosis safe aborts
      const abortData = await moloch.contract.methods.abort(0).encodeABI()
      await safeUtils.executeTransaction(lw, gnosisSafe, 'approve token transfer to moloch', [lw.accounts[0], lw.accounts[1]], moloch.address, 0, abortData, CALL, executor)
      const abortedProposal = await moloch.proposalQueue.call(0)
      assert.equal(abortedProposal.tokenTribute, 0)
    })

    describe('as a member, can execute all functions', async () => {
      beforeEach(async () => {
        // approve 100 eth from safe to moloch
        let data = await token.contract.methods.approve(moloch.address, 100).encodeABI()
        await safeUtils.executeTransaction(lw, gnosisSafe, 'approve token transfer to moloch', [lw.accounts[0], lw.accounts[1]], token.address, 0, data, CALL, executor)

        // summoner approves tokens and submits proposal for safe
        await token.approve(moloch.address, 10, { from: summoner })
        await moloch.submitProposal(proposal1.applicant, proposal1.tokenTribute, proposal1.sharesRequested, proposal1.details, { from: summoner })

        // summoner votes yes for safe
        await moveForwardPeriods(1)
        await moloch.submitVote(0, 1, { from: summoner })

        // fast forward until safe is a member
        await moveForwardPeriods(config.VOTING_DURATON_IN_PERIODS)
        await moveForwardPeriods(config.GRACE_DURATON_IN_PERIODS)
        await moloch.processProposal(0, { from: processor })
      })

      it('submit proposal -> vote -> update delegate -> ragequit', async () => {
        // confirm that the safe is a member
        const safeMemberData = await moloch.members(gnosisSafe.address)
        assert.equal(safeMemberData.exists, true)

        // create a new proposal
        proposal2 = {
          applicant: accounts[2],
          tokenTribute: 100,
          sharesRequested: 2,
          details: ""
        }

        // send the applicant 100 tokens and have them do the approval
        await token.transfer(proposal2.applicant, proposal2.tokenTribute, { from: creator })
        await token.approve(moloch.address, proposal2.tokenTribute, { from: proposal2.applicant})

        // safe needs to approve 10 for the deposit (get 10 more from creator)
        await token.transfer(gnosisSafe.address, 10, { from: creator })
        let data = await token.contract.methods.approve(moloch.address, 10).encodeABI()
        await safeUtils.executeTransaction(lw, gnosisSafe, 'approve token transfer to moloch', [lw.accounts[0], lw.accounts[1]], token.address, 0, data, CALL, executor)

        // safe submits proposal
        let submitProposalData = await moloch.contract.methods.submitProposal(proposal2.applicant, proposal2.tokenTribute, proposal2.sharesRequested, proposal2.details).encodeABI()
        await safeUtils.executeTransaction(lw, gnosisSafe, 'submit proposal to moloch', [lw.accounts[0], lw.accounts[1]], moloch.address, 0, submitProposalData, CALL, executor)

        const expectedStartingPeriod = (await moloch.getCurrentPeriod()).toNumber() + 1
        await verifySubmitProposal(proposal2, 1, gnosisSafe.address, {
          initialTotalShares: 2,
          initialProposalLength: 1,
          initialApplicantBalance: proposal2.tokenTribute,
          initialProposerBalance: 10,
          expectedStartingPeriod: expectedStartingPeriod
        })

        // safe submits vote
        await moveForwardPeriods(1)
        let voteData = await moloch.contract.methods.submitVote(1, 2).encodeABI() // vote no so we can ragequit easier
        await safeUtils.executeTransaction(lw, gnosisSafe, 'submit vote to moloch', [lw.accounts[0], lw.accounts[1]], moloch.address, 0, voteData, CALL, executor)
        await verifySubmitVote(proposal1, 1, gnosisSafe.address, 2, {})

        const newDelegateKey = accounts[5]

        // safe updates delegate key
        const updateDelegateData = await moloch.contract.methods.updateDelegateKey(newDelegateKey).encodeABI()
        await safeUtils.executeTransaction(lw, gnosisSafe, 'update delegate key', [lw.accounts[0], lw.accounts[1]], moloch.address, 0, updateDelegateData, CALL, executor)
        await verifyUpdateDelegateKey(gnosisSafe.address, gnosisSafe.address, newDelegateKey)

        // safe ragequits
        const ragequitData = await moloch.contract.methods.ragequit(1).encodeABI()
        await safeUtils.executeTransaction(lw, gnosisSafe, 'ragequit the guild', [lw.accounts[0], lw.accounts[1]], moloch.address, 0, ragequitData, CALL, executor)
        const safeMemberDataAfterRagequit = await moloch.members(gnosisSafe.address)
        assert.equal(safeMemberDataAfterRagequit.exists, true)
        assert.equal(safeMemberDataAfterRagequit.shares, 0)

        const safeBalanceAfterRagequit = await token.balanceOf(gnosisSafe.address)
        assert.equal(safeBalanceAfterRagequit, 50) // 100 eth & 2 shares at time of ragequit
      })
    })
  })*/
})
